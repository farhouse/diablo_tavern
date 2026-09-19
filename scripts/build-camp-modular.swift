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

guard CommandLine.arguments.count == 5 else {
  fputs("usage: build-camp-modular.swift REFERENCE BASE STASH APPRAISER\n", stderr)
  exit(2)
}

let root = FileManager.default.currentDirectoryPath
let output = "\(root)/public/images/game/camp-modular"
let reference = try loadPNG(CommandLine.arguments[1])
let generatedBase = try loadPNG(CommandLine.arguments[2])
let generatedStash = try trimmed(loadPNG(CommandLine.arguments[3]))
let generatedAppraiser = try trimmed(loadPNG(CommandLine.arguments[4]))

let canvasWidth = reference.width
let canvasHeight = reference.height
let base = try resized(generatedBase, width: canvasWidth, height: canvasHeight)
let stashWidth = 360
let stashHeight = Int((Double(generatedStash.height) / Double(generatedStash.width) * Double(stashWidth)).rounded())
let appraiserWidth = 447
let appraiserHeight = Int((Double(generatedAppraiser.height) / Double(generatedAppraiser.width) * Double(appraiserWidth)).rounded())
let stash = try resized(generatedStash, width: stashWidth, height: stashHeight)
let appraiser = try resized(generatedAppraiser, width: appraiserWidth, height: appraiserHeight)
let heroesUI = try cropped(reference, x: 0, y: 780, width: canvasWidth, height: canvasHeight - 780)

let stashLayer = Layer(name: "stashWagon", image: stash, x: 70, y: 91)
let appraiserLayer = Layer(name: "appraiser", image: appraiser, x: 1225, y: 215)
let uiLayer = Layer(name: "heroesUI", image: heroesUI, x: 0, y: 780)
let baseLayer = Layer(name: "campBase", image: base, x: 0, y: 0)

try savePNG(base, to: "\(output)/camp-base.png")
try savePNG(stash, to: "\(output)/expansion-stash-wagon.png")
try savePNG(appraiser, to: "\(output)/expansion-appraiser.png")
try savePNG(heroesUI, to: "\(output)/heroes-ui-strip.png")
try savePNG(try render(width: canvasWidth, height: canvasHeight, layers: [baseLayer, uiLayer]), to: "\(output)/comparison-base.png")
try savePNG(try render(width: canvasWidth, height: canvasHeight, layers: [baseLayer, stashLayer, appraiserLayer, uiLayer]), to: "\(output)/comparison-expanded.png")
try savePNG(try contrastSheet(stash), to: "\(root)/.multica/verify-stash-contrast.png")
try savePNG(try contrastSheet(appraiser), to: "\(root)/.multica/verify-appraiser-contrast.png")

print("canvas=\(canvasWidth)x\(canvasHeight)")
print("stash=\(stash.width)x\(stash.height)@70,91")
print("appraiser=\(appraiser.width)x\(appraiser.height)@1225,215")
print("heroesUI=\(heroesUI.width)x\(heroesUI.height)@0,780")
print("stashAlphaBBox=\(try alphaBounds(stash))")
print("appraiserAlphaBBox=\(try alphaBounds(appraiser))")
print("stashAlphaRange=\(try alphaRange(stash))")
print("appraiserAlphaRange=\(try alphaRange(appraiser))")
