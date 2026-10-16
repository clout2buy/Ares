# Making 3D models that look professional

The tool is the Forge studio (`Browser action:"model"`, `help:true` for the engine reference). This file is the ART: what a
3D artist does that makes a model read as real instead of "AI-ish". Do it in this order every time.

## 1. Read the subject before touching a shape
- Real thing or reference picture: list its parts, counts, materials and sizes first (`objects.md`). A screen-face robot =
  head shell + screen + 2 ear discs + 2 antenna fins + neck + chest plate + spine + hips + 2x(shoulder, upper arm, elbow,
  forearm guard, hand with 4 fingers + thumb) + 2x(thigh, knee, shin guard, ankle, shoe). Write that list down.
- From a picture: measure in HEAD UNITS on the front and side views (head width, total height, shoulder span, where the
  wrists, crotch and knees fall). A wrong proportion ruins a model more than any missing detail.
- Name the shape language: boxy, rounded, angular, organic, chunky toy, sleek. Keep every part in that language.

## 2. Primary forms (blockout) - the silhouette
- 3-8 big shapes. Check the silhouette black-on-white from front and side: it should already be recognisable.
- Overlap and interlock forms (a chest plate sits OVER the spine, a shin guard wraps the leg); never stack forms that just
  touch at a point. Tilt and taper: nothing real is a perfect axis-aligned box.

## 3. Secondary forms - what makes it read as designed
- Bevels on every hard edge (round 0.005-0.03 at human scale); no razor or fully round edges unless intended.
- Panel breaks: split big surfaces into plates with thin grooves (sub sticks 2-4 mm), offset plates slightly in depth.
- Contrast of scale: big calm surfaces next to small dense detail clusters (joints, vents, bolts). Even detail everywhere
  reads as noise; no detail reads as a blockout.
- Function: every detail should look like it does something: a joint can rotate, a vent breathes, a light shows state.

## 4. Tertiary detail - close-up quality
- Seams, screws, rivets, small vents, decals, glow strips; for creatures: knuckles, toe pads, eyelids, nostrils, wrinkles.
- Wear: edge wear (lighter paint on exposed edges), chips, grime in crevices (ao), scratches (tex hammered / rock at low
  strength, paint blobs). Clean CG = toy; a little wear = real.

## 5. Materials and colour
- 60/30/10: one dominant colour, one secondary, one accent (often emissive). Accents mark function (lights, screens).
- Every material is distinct in roughness/metalness, not just colour: paint (clearcoat), plastic (0.3-0.45 rough), rubber
  (0.9), metal (0.3, metal 1), glass, emissive. Black is never #000 (use #15171b); white is never #fff (#e4e4e0).
- Value structure: the face/head/focal point has the most contrast.

## 6. Rig and motion (always)
- Joints at the real pivots; check the rig moves without parts intersecting (shoulder pads clear the arm at 90 deg).
- Ship idle + one locomotion + one signature action (see physics.md and feel.md for timing and weight).

## 7. Compare and fix, like a lead reviewing an artist
- Look at front / side / back / 3q at the reference's angles. List the 3 biggest differences, biggest first (proportion >
  silhouette > material > detail). Fix those with op blob / op set, look once more. Do not polish details while a proportion
  is off.

## Hard-surface rules (robots, vehicles, weapons, props)
- hard:true sculpts; one part per material per limb; part-level mirror for left/right; hollow shells with real openings;
  small parts in their own part (they mesh finely). Real thickness on plates (3-15 mm), gaps between plates (2-5 mm).
## Organic rules (animals, characters)
- One skin sculpt; anatomy first (skeleton landmarks, muscle masses), then fur/skin detail; asymmetry in pose, symmetry in
  build; eyes set INTO sockets with lids, never floating spheres.
## Performance (games)
- Hero 20-60k triangles, props 1-10k, background 100-2k; poly:N decimates; reuse parts with instances and variants.
