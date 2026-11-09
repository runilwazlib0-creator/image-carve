# Image Carve

**Live site:** https://runilwazlib0-creator.github.io/image-carve/

Image Carve turns any photo into a strictly black and white **V-bit carving** style engraving. Bright areas become carved grooves (white), and shadows stay as uncut material (black). Everything runs in your browser. Images are never uploaded.

## How it works

This is a JavaScript port of `dore_carve_gradual.py`:

1. **Tone mapping.** Luminance goes through a light bilateral filter, gets mild sharpening, and then a gamma curve.
2. **Light direction field.** A structure tensor is built from softly blurred lighting gradients. Strong silhouette edges are clipped so they don't drive the field, it is biased toward an engraver's oblique slant, and then it is averaged into coherent local groups.
3. **Connected strokes.** Cuts grow from random seeds, longest first, with lognormal target lengths (11 to 155 px). They turn gently, and they stop at shadows, at sharp tonal edges, or where their clearance runs out.
4. **Continuous width.** Cut width rises smoothly with brightness and has a hard cap. Widths are smoothed along each stroke, the width slope is bounded, and the ends taper.
5. **Full-footprint safety.** Each stroke is rasterized at 4× subpixel resolution. The whole stroke is rejected if its footprint would touch protected shadows or features, merge with an existing cut (which keeps a black ridge between them), or enclose a black island. Nothing gets punched out after rendering.

The output contains only 0 and 255. Downloads are 1-bit PNGs at the working resolution, with optional 2× and 4× versions taken from the subpixel raster.

## Controls

| Control | Default | Effect |
|---|---|---|
| Line spacing | 3.8 px | Groove pitch; larger means coarser lines |
| Stroke length | 32 px | Median target length of the cuts |
| Gamma | 0.82 | Lower carves more of the midtones |
| Max cut width | 1.84 × spacing | Ceiling for the widest highlight cuts |
| Invert | off | Carves dark areas instead. Use it for bright backgrounds |
| Seed | 41 | Changes the random stroke placement |
| Working size | max 1600 px | Large images are downscaled before processing |

## Run locally

Any static server works, for example `python3 -m http.server`, then open http://localhost:8000.

## Notes

- The output is an artistic preview image. It is not a verified CNC toolpath, and it makes no promise about physical carvability.
- The random number generator differs from NumPy, so stroke placement differs from the Python output in detail. Tone, direction, and statistics match closely.
