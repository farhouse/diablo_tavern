import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Bitmap {
  let width: Int
  let height: Int
  let pixels: UnsafeMutablePointer<UInt8>
  let context: CGContext

  init(url: URL) throws {
    guard
      let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
      throw NSError(domain: "SpriteAtlas", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to read \(url.path)"])
    }

    width = image.width
    height = image.height
    pixels = .allocate(capacity: width * height * 4)
    pixels.initialize(repeating: 0, count: width * height * 4)

    guard let bitmapContext = CGContext(
      data: pixels,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
      throw NSError(domain: "SpriteAtlas", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to create bitmap context"])
    }

    context = bitmapContext
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  }

  func alphaBounds(in rect: CGRect) -> CGRect? {
    let minX = max(0, Int(rect.minX.rounded(.down)))
    let maxX = min(width, Int(rect.maxX.rounded(.up)))
    let minY = max(0, Int(rect.minY.rounded(.down)))
    let maxY = min(height, Int(rect.maxY.rounded(.up)))
    var left = maxX
    var right = minX
    var top = maxY
    var bottom = minY

    for y in minY..<maxY {
      for x in minX..<maxX where pixels[(y * width + x) * 4 + 3] > 8 {
        left = min(left, x)
        right = max(right, x)
        top = min(top, y)
        bottom = max(bottom, y)
      }
    }

    guard left <= right, top <= bottom else { return nil }
    return CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
  }

  func image(in rect: CGRect) -> CGImage? {
    guard let normalized = context.makeImage() else { return nil }
    return normalized.cropping(to: rect.integral)
  }
}

func writePng(_ image: CGImage, to url: URL) throws {
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    throw NSError(domain: "SpriteAtlas", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unable to create \(url.path)"])
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw NSError(domain: "SpriteAtlas", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unable to write \(url.path)"])
  }
}

func centeredSquare(around bounds: CGRect, cell: CGRect, side: CGFloat) -> CGRect {
  let centerX = bounds.midX
  let centerY = bounds.midY
  var x = centerX - side / 2
  var y = centerY - side / 2
  x = min(max(x, cell.minX), cell.maxX - side)
  y = min(max(y, cell.minY), cell.maxY - side)
  return CGRect(x: x.rounded(.down), y: y.rounded(.down), width: side, height: side)
}

let projectRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let sourceRoot = projectRoot.appendingPathComponent("sprite-work/source")
let outputRoot = projectRoot.appendingPathComponent("public/images/game")

func copySource(_ sourceName: String, to relativeDestination: String) throws {
  let source = sourceRoot.appendingPathComponent(sourceName)
  let destination = outputRoot.appendingPathComponent(relativeDestination)
  try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
  if FileManager.default.fileExists(atPath: destination.path) {
    try FileManager.default.removeItem(at: destination)
  }
  try FileManager.default.copyItem(at: source, to: destination)
}

try copySource("barbaro-supervivencia-46x70.png", to: "heroes/barbarian.png")
try copySource("sorceress-supervivencia-46x70.png", to: "heroes/sorceress.png")
try copySource("paladin-supervivencia-46x70.png", to: "heroes/paladin.png")
try copySource("necromancer-supervivencia-46x70.png", to: "heroes/necromancer.png")
try copySource("tavern-supervivencia-background.png", to: "tavern/background.png")

let equipmentNames = ["weapon", "armor", "helmet", "gloves", "boots", "ring", "amulet", "charm"]
let equipment = try Bitmap(url: sourceRoot.appendingPathComponent("equipment-supervivencia-source-sheet.png"))
let equipmentCellWidth = CGFloat(equipment.width) / 4
let equipmentCellHeight = CGFloat(equipment.height) / 2

for (index, name) in equipmentNames.enumerated() {
  let column = index % 4
  let row = index / 4
  let cell = CGRect(
    x: CGFloat(column) * equipmentCellWidth,
    y: CGFloat(row) * equipmentCellHeight,
    width: equipmentCellWidth,
    height: equipmentCellHeight
  )
  guard let bounds = equipment.alphaBounds(in: cell) else { continue }
  let side = min(416, floor(min(cell.width, cell.height)))
  let crop = centeredSquare(around: bounds, cell: cell, side: side)
  guard let image = equipment.image(in: crop) else { continue }
  try writePng(image, to: outputRoot.appendingPathComponent("items/\(name).png"))
}

let buildingNames = ["wagons", "scout-table", "stash-wagon", "infirmary", "appraiser"]
let buildings = try Bitmap(url: sourceRoot.appendingPathComponent("caravan-buildings-supervivencia-source-sheet.png"))
// The generated structures cross the conceptual equal-width grid. These verified
// gutters exclude neighboring poles, wheels, and fabric from each output.
let buildingRanges: [(start: CGFloat, end: CGFloat)] = [
  (0, 410),
  (420, 800),
  (800, 1200),
  (1200, 1590),
  (1610, CGFloat(buildings.width))
]

for (index, name) in buildingNames.enumerated() {
  let range = buildingRanges[index]
  let cell = CGRect(x: range.start, y: 0, width: range.end - range.start, height: CGFloat(buildings.height))
  guard let bounds = buildings.alphaBounds(in: cell) else { continue }
  let padding: CGFloat = 8
  let crop = CGRect(
    x: max(cell.minX, bounds.minX - padding).rounded(.down),
    y: max(0, bounds.minY - padding).rounded(.down),
    width: min(cell.maxX, bounds.maxX + padding) - max(cell.minX, bounds.minX - padding),
    height: min(CGFloat(buildings.height), bounds.maxY + padding) - max(0, bounds.minY - padding)
  ).integral
  guard let image = buildings.image(in: crop) else { continue }
  try writePng(image, to: outputRoot.appendingPathComponent("caravan/\(name).png"))
}

print("Generated 4 heroes, 8 item icons, 5 caravan buildings, and 1 Tavern background in public/images/game")
