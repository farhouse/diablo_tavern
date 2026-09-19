#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct RasterError: Error, CustomStringConvertible {
  let description: String
}

struct Layer {
  let name: String
  let image: CGImage
  let x: Int
  let y: Int
}

struct Manifest: Decodable {
  let canvas: ManifestCanvas
  let layers: [ManifestLayer]
  let compositions: [String: [String]]
}

struct ManifestCanvas: Decodable {
  let width: Int
  let height: Int
}

struct ManifestLayer: Decodable {
  let id: String
  let file: String
  let width: Int
  let height: Int
  let x: Int
  let y: Int
  let zIndex: Int
  let alphaBBox: ManifestRect?
}

struct ManifestRect: Decodable {
  let x: Int
  let y: Int
  let width: Int
  let height: Int
}

func loadPNG(_ path: String) throws -> CGImage {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let source = CGImageSourceCreateWithURL(url, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw RasterError(description: "Unable to load PNG: \(path)")
  }
  return image
}

func makeContext(width: Int, height: Int) throws -> CGContext {
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  guard let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else {
    throw RasterError(description: "Unable to create \(width)x\(height) bitmap context")
  }
  context.interpolationQuality = .none
  return context
}

func render(width: Int, height: Int, layers: [Layer]) throws -> CGImage {
  let context = try makeContext(width: width, height: height)
  context.clear(CGRect(x: 0, y: 0, width: width, height: height))
  for layer in layers {
    let drawY = height - layer.y - layer.image.height
    context.draw(layer.image, in: CGRect(x: layer.x, y: drawY, width: layer.image.width, height: layer.image.height))
  }
  guard let image = context.makeImage() else {
    throw RasterError(description: "Unable to render image")
  }
  return image
}

func resized(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
  let context = try makeContext(width: width, height: height)
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  guard let result = context.makeImage() else {
    throw RasterError(description: "Unable to resize image")
  }
  return result
}

func cropped(_ image: CGImage, x: Int, y: Int, width: Int, height: Int) throws -> CGImage {
  guard let result = image.cropping(to: CGRect(x: x, y: y, width: width, height: height)) else {
    throw RasterError(description: "Unable to crop image")
  }
  return result
}

func alphaBounds(_ image: CGImage) throws -> CGRect {
  let context = try makeContext(width: image.width, height: image.height)
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  guard let data = context.data else { throw RasterError(description: "Unable to inspect alpha") }
  let bytes = data.bindMemory(to: UInt8.self, capacity: image.width * image.height * 4)
  var minX = image.width
  var minY = image.height
  var maxX = -1
  var maxY = -1
  for y in 0..<image.height {
    for x in 0..<image.width where bytes[(y * image.width + x) * 4 + 3] > 0 {
      minX = min(minX, x)
      minY = min(minY, y)
      maxX = max(maxX, x)
      maxY = max(maxY, y)
    }
  }
  guard maxX >= minX, maxY >= minY else { throw RasterError(description: "Image has an empty alpha channel") }
  return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

func alphaRange(_ image: CGImage) throws -> ClosedRange<UInt8> {
  let context = try makeContext(width: image.width, height: image.height)
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  guard let data = context.data else { throw RasterError(description: "Unable to inspect alpha") }
  let bytes = data.bindMemory(to: UInt8.self, capacity: image.width * image.height * 4)
  var minimum = UInt8.max
  var maximum = UInt8.min
  for pixel in 0..<(image.width * image.height) {
    let alpha = bytes[pixel * 4 + 3]
    minimum = min(minimum, alpha)
    maximum = max(maximum, alpha)
  }
  return minimum...maximum
}

func clearedAlphaFringe(_ image: CGImage, threshold: UInt8 = 3) throws -> CGImage {
  let context = try makeContext(width: image.width, height: image.height)
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  guard let data = context.data else { throw RasterError(description: "Unable to normalize alpha fringe") }
  let bytes = data.bindMemory(to: UInt8.self, capacity: image.width * image.height * 4)
  for pixel in 0..<(image.width * image.height) where bytes[pixel * 4 + 3] <= threshold {
    bytes[pixel * 4] = 0
    bytes[pixel * 4 + 1] = 0
    bytes[pixel * 4 + 2] = 0
    bytes[pixel * 4 + 3] = 0
  }
  guard let result = context.makeImage() else {
    throw RasterError(description: "Unable to render normalized alpha image")
  }
  return result
}

func trimmed(_ image: CGImage, padding: Int = 4) throws -> CGImage {
  let bounds = try alphaBounds(image)
  let x = max(0, Int(bounds.minX) - padding)
  let yFromBottom = max(0, Int(bounds.minY) - padding)
  let maxX = min(image.width, Int(bounds.maxX) + padding)
  let maxY = min(image.height, Int(bounds.maxY) + padding)
  guard let result = image.cropping(to: CGRect(x: x, y: yFromBottom, width: maxX - x, height: maxY - yFromBottom)) else {
    throw RasterError(description: "Unable to trim alpha bounds")
  }
  return result
}

func savePNG(_ image: CGImage, to path: String) throws {
  let url = URL(fileURLWithPath: path)
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    throw RasterError(description: "Unable to create PNG destination: \(path)")
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw RasterError(description: "Unable to write PNG: \(path)")
  }
}

func contrastSheet(_ image: CGImage) throws -> CGImage {
  let context = try makeContext(width: image.width * 3, height: image.height)
  let colors: [(CGFloat, CGFloat, CGFloat)] = [(0.93, 0.93, 0.90), (0.03, 0.04, 0.06), (0.85, 0.05, 0.55)]
  for (index, color) in colors.enumerated() {
    let x = index * image.width
    context.setFillColor(red: color.0, green: color.1, blue: color.2, alpha: 1)
    context.fill(CGRect(x: x, y: 0, width: image.width, height: image.height))
    context.draw(image, in: CGRect(x: x, y: 0, width: image.width, height: image.height))
  }
  guard let result = context.makeImage() else {
    throw RasterError(description: "Unable to render contrast sheet")
  }
  return result
}

func loadManifest(_ path: String) throws -> Manifest {
  try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
}

func manifestLayer(_ id: String, in manifest: Manifest) throws -> ManifestLayer {
  guard let layer = manifest.layers.first(where: { $0.id == id }) else {
    throw RasterError(description: "Manifest layer not found: \(id)")
  }
  return layer
}

func renderedPixels(_ image: CGImage) throws -> Data {
  let context = try makeContext(width: image.width, height: image.height)
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  guard let data = context.data else { throw RasterError(description: "Unable to read rendered pixels") }
  return Data(bytes: data, count: image.width * image.height * 4)
}

func compose(_ ids: [String], manifest: Manifest, output: String) throws -> CGImage {
  let layers = try ids.map { id -> Layer in
    let item = try manifestLayer(id, in: manifest)
    let image = try loadPNG("\(output)/\(item.file)")
    return Layer(name: id, image: image, x: item.x, y: item.y)
  }
  return try render(width: manifest.canvas.width, height: manifest.canvas.height, layers: layers)
}

func verify(manifest: Manifest, output: String) throws {
  for item in manifest.layers {
    let image = try loadPNG("\(output)/\(item.file)")
    guard image.width == item.width, image.height == item.height else {
      throw RasterError(description: "Dimension mismatch for \(item.file): \(image.width)x\(image.height)")
    }
    if let expected = item.alphaBBox {
      let actual = try alphaBounds(image)
      let matches = Int(actual.minX) == expected.x && Int(actual.minY) == expected.y
        && Int(actual.width) == expected.width && Int(actual.height) == expected.height
      guard matches else { throw RasterError(description: "Alpha bounds mismatch for \(item.file): \(actual)") }
      guard try alphaRange(image) == UInt8.min...UInt8.max else {
        throw RasterError(description: "Expected full transparent/opaque alpha range in \(item.file)")
      }
    }
  }
  for (file, ids) in manifest.compositions {
    let rebuilt = try compose(ids, manifest: manifest, output: output)
    let committed = try loadPNG("\(output)/\(file)")
    guard try renderedPixels(rebuilt) == renderedPixels(committed) else {
      throw RasterError(description: "Pixel mismatch in composition: \(file)")
    }
  }
}

let root = FileManager.default.currentDirectoryPath
let output = "\(root)/public/images/game/camp-modular"
let manifest = try loadManifest("\(output)/manifest.json")

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--verify" {
  try verify(manifest: manifest, output: output)
  print("verification=ok")
  exit(0)
}

let defaultSources = [
  "\(root)/references/alta-53/01-campamento-anochecer-v2.png",
  "\(root)/references/alta-53/imagegen/camp-base-selected.png",
  "\(root)/references/alta-53/imagegen/stash-wagon-selected.png",
  "\(root)/references/alta-53/imagegen/appraiser-selected.png"
]
let sources: [String]
if CommandLine.arguments.count == 1 {
  sources = defaultSources
} else if CommandLine.arguments.count == 5 {
  sources = Array(CommandLine.arguments.dropFirst())
} else {
  fputs("usage: build-camp-modular.swift [--verify | REFERENCE BASE STASH APPRAISER]\n", stderr)
  exit(2)
}

let reference = try loadPNG(sources[0])
let generatedBase = try loadPNG(sources[1])
let generatedStash = try trimmed(clearedAlphaFringe(loadPNG(sources[2])))
let generatedAppraiser = try trimmed(clearedAlphaFringe(loadPNG(sources[3])))
guard reference.width == manifest.canvas.width, reference.height == manifest.canvas.height else {
  throw RasterError(description: "Reference dimensions do not match manifest canvas")
}

let baseSpec = try manifestLayer("campBase", in: manifest)
let stashSpec = try manifestLayer("stashWagon", in: manifest)
let appraiserSpec = try manifestLayer("appraiser", in: manifest)
let uiSpec = try manifestLayer("heroesUI", in: manifest)
let base = try resized(generatedBase, width: baseSpec.width, height: baseSpec.height)
let stash = try resized(generatedStash, width: stashSpec.width, height: stashSpec.height)
let appraiser = try resized(generatedAppraiser, width: appraiserSpec.width, height: appraiserSpec.height)
let heroesUI = try cropped(reference, x: 0, y: uiSpec.y, width: uiSpec.width, height: uiSpec.height)

for (spec, image) in [(baseSpec, base), (stashSpec, stash), (appraiserSpec, appraiser), (uiSpec, heroesUI)] {
  try savePNG(image, to: "\(output)/\(spec.file)")
}
for (file, ids) in manifest.compositions {
  try savePNG(try compose(ids, manifest: manifest, output: output), to: "\(output)/\(file)")
}
try savePNG(try contrastSheet(stash), to: "\(root)/.multica/verify-stash-contrast.png")
try savePNG(try contrastSheet(appraiser), to: "\(root)/.multica/verify-appraiser-contrast.png")
try verify(manifest: manifest, output: output)

print("canvas=\(manifest.canvas.width)x\(manifest.canvas.height)")
print("stash=\(stash.width)x\(stash.height)@\(stashSpec.x),\(stashSpec.y)")
print("appraiser=\(appraiser.width)x\(appraiser.height)@\(appraiserSpec.x),\(appraiserSpec.y)")
print("heroesUI=\(heroesUI.width)x\(heroesUI.height)@\(uiSpec.x),\(uiSpec.y)")
print("stashAlphaBBox=\(try alphaBounds(stash))")
print("appraiserAlphaBBox=\(try alphaBounds(appraiser))")
print("stashAlphaRange=\(try alphaRange(stash))")
print("appraiserAlphaRange=\(try alphaRange(appraiser))")
print("verification=ok")
