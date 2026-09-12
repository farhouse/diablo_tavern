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

func writeResizedPng(_ image: CGImage, width: Int, height: Int, to url: URL) throws {
  let pixels = UnsafeMutablePointer<UInt8>.allocate(capacity: width * height * 4)
  defer { pixels.deallocate() }
  pixels.initialize(repeating: 0, count: width * height * 4)

  guard let context = CGContext(
    data: pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else {
    throw NSError(domain: "SpriteAtlas", code: 5, userInfo: [NSLocalizedDescriptionKey: "Unable to resize image for \(url.path)"])
  }

  context.interpolationQuality = .none
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  guard let resized = context.makeImage() else {
    throw NSError(domain: "SpriteAtlas", code: 6, userInfo: [NSLocalizedDescriptionKey: "Unable to encode resized image for \(url.path)"])
  }
  try writePng(resized, to: url)
}

func fittedSize(for image: CGImage, maximumDimension: Int) -> (width: Int, height: Int) {
  let scale = min(1, Double(maximumDimension) / Double(max(image.width, image.height)))
  return (
    width: max(1, Int((Double(image.width) * scale).rounded())),
    height: max(1, Int((Double(image.height) * scale).rounded()))
  )
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
let publicImagesRoot = projectRoot.appendingPathComponent("public/images")
let outputRoot = publicImagesRoot.appendingPathComponent(".game-staging-\(UUID().uuidString)")
let finalOutputRoot = publicImagesRoot.appendingPathComponent("game")
let backupRoot = publicImagesRoot.appendingPathComponent(".game-backup-\(UUID().uuidString)")
let fileManager = FileManager.default

defer {
  try? fileManager.removeItem(at: outputRoot)
  try? fileManager.removeItem(at: backupRoot)
}

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

let tavern = try Bitmap(url: sourceRoot.appendingPathComponent("tavern-supervivencia-background.png"))
guard let tavernImage = tavern.context.makeImage() else {
  throw NSError(domain: "SpriteAtlas", code: 7, userInfo: [NSLocalizedDescriptionKey: "Unable to render the Tavern background"])
}
try writeResizedPng(tavernImage, width: 1280, height: 720, to: outputRoot.appendingPathComponent("tavern/background.png"))

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
  guard let bounds = equipment.alphaBounds(in: cell) else {
    throw NSError(domain: "SpriteAtlas", code: 8, userInfo: [NSLocalizedDescriptionKey: "No visible pixels found for item \(name)"])
  }
  let side = min(416, floor(min(cell.width, cell.height)))
  let crop = centeredSquare(around: bounds, cell: cell, side: side)
  guard let image = equipment.image(in: crop) else {
    throw NSError(domain: "SpriteAtlas", code: 9, userInfo: [NSLocalizedDescriptionKey: "Unable to crop item \(name)"])
  }
  try writeResizedPng(image, width: 96, height: 96, to: outputRoot.appendingPathComponent("items/\(name).png"))
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
  guard let bounds = buildings.alphaBounds(in: cell) else {
    throw NSError(domain: "SpriteAtlas", code: 10, userInfo: [NSLocalizedDescriptionKey: "No visible pixels found for building \(name)"])
  }
  let padding: CGFloat = 8
  let crop = CGRect(
    x: max(cell.minX, bounds.minX - padding).rounded(.down),
    y: max(0, bounds.minY - padding).rounded(.down),
    width: min(cell.maxX, bounds.maxX + padding) - max(cell.minX, bounds.minX - padding),
    height: min(CGFloat(buildings.height), bounds.maxY + padding) - max(0, bounds.minY - padding)
  ).integral
  guard let image = buildings.image(in: crop) else {
    throw NSError(domain: "SpriteAtlas", code: 11, userInfo: [NSLocalizedDescriptionKey: "Unable to crop building \(name)"])
  }
  let size = fittedSize(for: image, maximumDimension: 256)
  try writeResizedPng(image, width: size.width, height: size.height, to: outputRoot.appendingPathComponent("caravan/\(name).png"))
}

let expectedFiles = [
  "heroes/barbarian.png", "heroes/sorceress.png", "heroes/paladin.png", "heroes/necromancer.png",
  "items/weapon.png", "items/armor.png", "items/helmet.png", "items/gloves.png",
  "items/boots.png", "items/ring.png", "items/amulet.png", "items/charm.png",
  "caravan/wagons.png", "caravan/scout-table.png", "caravan/stash-wagon.png",
  "caravan/infirmary.png", "caravan/appraiser.png", "tavern/background.png"
]

for relativePath in expectedFiles {
  let file = outputRoot.appendingPathComponent(relativePath)
  let attributes = try fileManager.attributesOfItem(atPath: file.path)
  guard let size = attributes[.size] as? NSNumber, size.intValue > 0 else {
    throw NSError(domain: "SpriteAtlas", code: 12, userInfo: [NSLocalizedDescriptionKey: "Generated file is empty: \(relativePath)"])
  }
}

if fileManager.fileExists(atPath: finalOutputRoot.path) {
  try fileManager.moveItem(at: finalOutputRoot, to: backupRoot)
}

do {
  try fileManager.moveItem(at: outputRoot, to: finalOutputRoot)
  try? fileManager.removeItem(at: backupRoot)
} catch {
  if fileManager.fileExists(atPath: backupRoot.path) && !fileManager.fileExists(atPath: finalOutputRoot.path) {
    try? fileManager.moveItem(at: backupRoot, to: finalOutputRoot)
  }
  throw error
}

print("Generated 4 heroes, 8 item icons, 5 caravan buildings, and 1 Tavern background in public/images/game")
