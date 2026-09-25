"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScreenCapture = void 0;
exports.cropScreenshotRegion = cropScreenshotRegion;
const electron_1 = require("electron");
const coordinates_1 = require("../services/coordinates");
const JPEG_QUALITY = 85;
const REFINEMENT_CROP_JPEG_QUALITY = 95;
class ScreenCapture {
    /**
     * Capture all screens. Returns a downsampled JPEG for pass-1 input and retains
     * the native-resolution image on each result for refinement.
     */
    async captureAllScreens() {
        const displays = electron_1.screen.getAllDisplays();
        // Ask for the largest native-pixel edge across all displays. Electron clamps
        // to what the OS provides, so an oversized request is safe.
        let maxNativeEdge = coordinates_1.MAX_MODEL_IMAGE_EDGE;
        for (const display of displays) {
            const scaleFactor = display.scaleFactor || 1;
            maxNativeEdge = Math.max(maxNativeEdge, Math.ceil(display.bounds.width * scaleFactor), Math.ceil(display.bounds.height * scaleFactor));
        }
        const sources = await electron_1.desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: maxNativeEdge, height: maxNativeEdge },
        });
        const results = [];
        // Correlate sources with displays by id. The order of `sources` is NOT
        // guaranteed to match `displays` — on Windows it usually does, but Electron
        // explicitly warns against relying on it.
        const anySourceHasDisplayId = sources.some((source) => source.display_id);
        for (let index = 0; index < displays.length; index++) {
            const display = displays[index];
            const matchedById = sources.find((source) => source.display_id && source.display_id === String(display.id));
            if (!matchedById && anySourceHasDisplayId) {
                console.warn(`[gemair] no desktopCapturer source matched display.id=${display.id} (index ${index}); ` +
                    "falling back to positional match. Screenshot may be routed to the wrong monitor.");
            }
            const source = matchedById || sources[index] || sources[0];
            if (!source)
                continue;
            const fullResolutionImage = source.thumbnail;
            if (fullResolutionImage.isEmpty())
                continue;
            const nativeSize = fullResolutionImage.getSize();
            const targetImageSize = (0, coordinates_1.imageDimensionsForCapture)(nativeSize);
            const downsampled = targetImageSize.width === nativeSize.width && targetImageSize.height === nativeSize.height
                ? fullResolutionImage
                : fullResolutionImage.resize({
                    width: targetImageSize.width,
                    height: targetImageSize.height,
                });
            const actualImageSize = downsampled.getSize();
            results.push({
                data: downsampled.toJPEG(JPEG_QUALITY).toString("base64"),
                displayIndex: index,
                bounds: display.bounds,
                imageDimensions: { width: actualImageSize.width, height: actualImageSize.height },
                nativeDimensions: { width: nativeSize.width, height: nativeSize.height },
                _source: fullResolutionImage,
            });
        }
        // Ordering stays aligned with `screen.getAllDisplays()`, which is also the
        // order the overlay windows are created in, so a POINT tag's `screen` field
        // indexes into either array.
        return results;
    }
    getCursorPosition() {
        return electron_1.screen.getCursorScreenPoint();
    }
}
exports.ScreenCapture = ScreenCapture;
/**
 * Cut a square patch around a first-pass point for second-pass refinement.
 *
 * The centre is given in IMAGE space (the space the model pointed in). The cut is
 * made from the native-resolution image so the model sees the patch at real
 * display density — that is the whole reason the second pass helps.
 */
function cropScreenshotRegion(shot, centerInImageSpace, cropSizeInImageSpace) {
    const sourceImage = shot._source ?? electron_1.nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    const nativeSize = shot._source
        ? shot.nativeDimensions
        : { width: shot.imageDimensions.width, height: shot.imageDimensions.height };
    const plan = (0, coordinates_1.planRefinementCrop)({
        imageDimensions: shot.imageDimensions,
        nativeSize,
        centerInImageSpace,
        cropSizeInImageSpace,
    });
    const cropped = sourceImage.crop({
        x: plan.nativeRect.x,
        y: plan.nativeRect.y,
        width: Math.max(1, plan.nativeRect.width),
        height: Math.max(1, plan.nativeRect.height),
    });
    const croppedSize = cropped.getSize();
    return {
        data: cropped.toJPEG(REFINEMENT_CROP_JPEG_QUALITY).toString("base64"),
        cropSize: { width: croppedSize.width, height: croppedSize.height },
        plan,
    };
}
