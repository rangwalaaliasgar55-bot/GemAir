"use strict";
/**
 * coordinates.ts
 *
 * The three coordinate spaces the pointing pipeline moves between, and every
 * conversion between them. Upstream's own architecture notes call this the
 * easiest thing in the system to break, so it lives here as pure arithmetic with
 * no Electron import — which is what makes it testable without a screen.
 *
 * ## The three spaces
 *
 * 1. NATIVE space  — real device pixels of one display. On a 2x display a
 *                    1920x1080 desktop is 3840x2160 native pixels. This is what
 *                    `desktopCapturer` hands back and what a refinement crop is
 *                    taken from, because cropping at native density is the whole
 *                    reason the second pass is sharper than the first.
 *
 * 2. IMAGE space   — the downsampled JPEG actually sent to the model, long edge
 *                    clamped to `MAX_MODEL_IMAGE_EDGE`. The model's `[POINT:x,y]`
 *                    tags are in THIS space, because it is the only image it saw.
 *
 * 3. DISPLAY space — Electron's `display.bounds`, i.e. device-independent
 *                    pixels. The overlay window is sized in this space, so a
 *                    point must land here before it can be drawn.
 *
 * The pipeline is: capture NATIVE -> downsample to IMAGE -> model points in
 * IMAGE -> crop back to NATIVE around that point -> model refines in CROP
 * pixels -> map back to IMAGE -> scale to DISPLAY -> draw.
 *
 * The bug this module exists to prevent is applying one space's scale factor to
 * another space's number, which on a 2x display is silently off by exactly 2x —
 * close enough to look like a mediocre model and not like a unit error.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MODEL_IMAGE_EDGE = void 0;
exports.imageDimensionsForCapture = imageDimensionsForCapture;
exports.imagePointToDisplayPoint = imagePointToDisplayPoint;
exports.clampPointToBounds = clampPointToBounds;
exports.planRefinementCrop = planRefinementCrop;
exports.refinedCropPointToImagePoint = refinedCropPointToImagePoint;
exports.resolvePointForOverlay = resolvePointForOverlay;
exports.parsePointTags = parsePointTags;
exports.stripPointTags = stripPointTags;
/**
 * 1568 is Anthropic's recommended max edge for vision input. Going higher on the
 * pass-1 image triggers API-side downscaling, which shifts every coordinate the
 * model returns without telling us the factor it used.
 */
exports.MAX_MODEL_IMAGE_EDGE = 1568;
/**
 * NATIVE -> IMAGE. The size of the JPEG to send the model for a capture of
 * `nativeSize`, preserving aspect ratio and never upscaling.
 */
function imageDimensionsForCapture(nativeSize, maximumEdge = exports.MAX_MODEL_IMAGE_EDGE) {
    const longestEdge = Math.max(nativeSize.width, nativeSize.height);
    if (longestEdge <= maximumEdge || longestEdge === 0) {
        return { width: nativeSize.width, height: nativeSize.height };
    }
    return {
        width: Math.round((nativeSize.width * maximumEdge) / longestEdge),
        height: Math.round((nativeSize.height * maximumEdge) / longestEdge),
    };
}
/**
 * IMAGE -> DISPLAY. Turns a model-supplied point into the overlay window's own
 * coordinate space.
 *
 * `displayBounds` is in device-independent pixels and `imageDimensions` is in
 * downsampled image pixels, so the ratio between them already folds in BOTH the
 * display's scale factor and the downsample — which is exactly why the scale
 * factor must not be applied again anywhere else.
 */
function imagePointToDisplayPoint(imagePoint, imageDimensions, displayBounds) {
    if (imageDimensions.width === 0 || imageDimensions.height === 0) {
        return { x: 0, y: 0 };
    }
    const horizontalScale = displayBounds.width / imageDimensions.width;
    const verticalScale = displayBounds.height / imageDimensions.height;
    return {
        x: Math.round(imagePoint.x * horizontalScale),
        y: Math.round(imagePoint.y * verticalScale),
    };
}
/** Keeps a display-space point inside the overlay it is about to be drawn on. */
function clampPointToBounds(point, bounds) {
    return {
        x: Math.min(Math.max(point.x, 0), Math.max(bounds.width - 1, 0)),
        y: Math.min(Math.max(point.y, 0), Math.max(bounds.height - 1, 0)),
    };
}
/**
 * IMAGE -> NATIVE. Plans a square crop centred on a point the model gave us in
 * IMAGE space, cut from the NATIVE capture so the model sees the patch at full
 * display density.
 *
 * `cropSizeInImageSpace` is deliberately expressed in image pixels: the caller
 * is reasoning about "roughly 300 px of what the model already looked at", not
 * about device pixels it never saw.
 */
function planRefinementCrop(options) {
    const { imageDimensions, nativeSize, centerInImageSpace, cropSizeInImageSpace } = options;
    const nativePixelsPerImagePixel = imageDimensions.width === 0 ? 1 : nativeSize.width / imageDimensions.width;
    const nativeCenterX = centerInImageSpace.x * nativePixelsPerImagePixel;
    const nativeCenterY = centerInImageSpace.y * nativePixelsPerImagePixel;
    const nativeCropSize = cropSizeInImageSpace * nativePixelsPerImagePixel;
    const halfCropSize = nativeCropSize / 2;
    // Clamp so the crop stays entirely on screen. A crop larger than the display
    // collapses to the display itself rather than going negative.
    const maximumX = Math.max(0, nativeSize.width - nativeCropSize);
    const maximumY = Math.max(0, nativeSize.height - nativeCropSize);
    const nativeX = Math.round(Math.min(Math.max(0, nativeCenterX - halfCropSize), maximumX));
    const nativeY = Math.round(Math.min(Math.max(0, nativeCenterY - halfCropSize), maximumY));
    const nativeWidth = Math.round(Math.min(nativeCropSize, nativeSize.width - nativeX));
    const nativeHeight = Math.round(Math.min(nativeCropSize, nativeSize.height - nativeY));
    return {
        nativeRect: { x: nativeX, y: nativeY, width: nativeWidth, height: nativeHeight },
        originInImageSpace: {
            x: nativeX / nativePixelsPerImagePixel,
            y: nativeY / nativePixelsPerImagePixel,
        },
        nativePixelsPerImagePixel,
    };
}
/**
 * CROP -> IMAGE. Maps the second pass's answer, which is in the crop's own pixel
 * space, back to the IMAGE space the first pass used, so the single
 * `imagePointToDisplayPoint` conversion still serves both passes.
 */
function refinedCropPointToImagePoint(refinedPointInCropSpace, cropPlan) {
    const scale = cropPlan.nativePixelsPerImagePixel || 1;
    return {
        x: cropPlan.originInImageSpace.x + refinedPointInCropSpace.x / scale,
        y: cropPlan.originInImageSpace.y + refinedPointInCropSpace.y / scale,
    };
}
/**
 * The whole pipeline in one call, for the common case: the model pointed in
 * IMAGE space, an optional refinement came back in CROP space, and the overlay
 * needs a DISPLAY-space point that is definitely on screen.
 */
function resolvePointForOverlay(options) {
    const pointInImageSpace = options.refinement
        ? refinedCropPointToImagePoint(options.refinement.pointInCropSpace, options.refinement.cropPlan)
        : options.imagePoint;
    return clampPointToBounds(imagePointToDisplayPoint(pointInImageSpace, options.imageDimensions, options.displayBounds), options.displayBounds);
}
/**
 * Pulls `[POINT:x,y:label:screenN]` tags out of the model's text. Kept next to
 * the conversions because the tags are the pipeline's entry point and their
 * coordinates are always IMAGE space.
 */
function parsePointTags(text) {
    const pattern = /\[POINT:(\d+),(\d+):([^:\]]+):screen(\d+)\]/g;
    const tags = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        tags.push({
            x: Number.parseInt(match[1], 10),
            y: Number.parseInt(match[2], 10),
            label: match[3],
            screen: Number.parseInt(match[4], 10),
        });
    }
    return tags;
}
/** The text the user actually reads: the same message with the tags taken out. */
function stripPointTags(text) {
    return text.replace(/\[POINT:[^\]]+\]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}
