/**
 * Reading text out of an image, locally and for free.
 *
 * The whole photo pipeline rests on this being cheap. If OCR costs money the
 * cascade collapses, because the stage that filters ninety-nine images in a
 * hundred is the stage that reads them, and a filter more expensive than the
 * thing it protects is not a filter.
 *
 * ## Engines
 *
 * Three, tried in order, and the third is doing nothing.
 *
 * **Vision.** macOS has had a good text recogniser built in since Monterey and
 * it is what Preview and Spotlight use. There is no command for it, so this
 * drives it through a small Swift program written to a temp file and compiled
 * on first use. That needs the command line tools, which most people on a Mac
 * with a development environment already have, and which this checks for rather
 * than assumes.
 *
 * **Tesseract.** If it is on PATH. Worse than Vision on receipts and better
 * than nothing, and it is the only option on Linux.
 *
 * **None.** The honest state on a machine with neither. Photos still arrive
 * with their metadata, they are simply not searchable by their contents, and
 * every downstream stage treats an image with no text the way it treats a
 * photograph of a dog. Nothing breaks and nothing is silently wrong.
 *
 * ## Why not a local vision model
 *
 * A small multimodal model would do better than OCR at deciding what a picture
 * *is*. It would also be seconds per image rather than a tenth of a second,
 * which over a library of forty thousand is the difference between a background
 * pass and a weekend. OCR plus rules gets most of the value at a hundredth of
 * the cost, and the images where it fails -- a photograph of a whiteboard, a
 * screenshot of a graph -- are ones where the extra cost buys little anyway.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface OcrEngine {
  readonly id: string;
  /** Text, or null when the engine could not read the file at all. */
  read(path: string): string | null;
}

/**
 * The Swift that drives Vision.
 *
 * Written out and compiled once. `accurate` rather than `fast` because these
 * are receipts and dense small print is exactly where the fast path gives up,
 * and because the cost is paid once per image ever.
 */
const VISION_SOURCE = `
import Foundation
import Vision
import AppKit

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([request])

for case let observation as VNRecognizedTextObservation in request.results ?? [] {
  if let best = observation.topCandidates(1).first {
    print(best.string)
  }
}
`;

function toolchainPresent(): boolean {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

function binaryOnPath(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

function visionEngine(): OcrEngine | null {
  if (process.platform !== "darwin" || !toolchainPresent()) {
    return null;
  }

  const directory = join(tmpdir(), "harbor-ocr");
  const binary = join(directory, "harbor-vision");

  if (!existsSync(binary)) {
    try {
      mkdirSync(directory, { recursive: true });

      const source = join(directory, "vision.swift");

      writeFileSync(source, VISION_SOURCE, { mode: 0o600 });

      execFileSync("xcrun", ["swiftc", "-O", "-o", binary, source], { stdio: "ignore" });
    } catch {
      return null;
    }
  }

  return {
    id: "vision",
    read(path) {
      try {
        // A generous timeout rather than none. A corrupt image can hang the
        // recogniser, and one bad file should cost a second rather than the
        // whole pass.
        return execFileSync(binary, [path], {
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch {
        return null;
      }
    },
  };
}

function tesseractEngine(): OcrEngine | null {
  if (!binaryOnPath("tesseract")) {
    return null;
  }

  return {
    id: "tesseract",
    read(path) {
      try {
        return execFileSync("tesseract", [path, "stdout", "--psm", "6"], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return null;
      }
    },
  };
}

/** An engine that reads nothing, so the rest of the pipeline has one shape. */
export const NO_OCR: OcrEngine = {
  id: "none",
  read: () => null,
};

let cached: OcrEngine | null = null;

/**
 * The best engine this machine has.
 *
 * Detected once per process, because compiling the Swift is the expensive part
 * and `which` is not free either when it is called per image.
 */
export function ocrEngine(): OcrEngine {
  if (cached !== null) {
    return cached;
  }

  cached = visionEngine() ?? tesseractEngine() ?? NO_OCR;

  return cached;
}

/** For tests, and for `harbor doctor` reporting what it would use. */
export function describeEngine(engine: OcrEngine): string {
  if (engine.id === "vision") {
    return "macOS Vision, on-device";
  }

  if (engine.id === "tesseract") {
    return "tesseract, on-device";
  }

  return "none: photos will be stored with their metadata but not their contents";
}

/** Overridable, so a test can drive the pipeline without an image on disk. */
export function setEngine(engine: OcrEngine | null): void {
  cached = engine;
}
