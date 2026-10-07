# 3D assets — generation, import, materials, collision, animation

## Ways to get a model, best first

1. **Godot primitives** for blockouts: `MeshInstance3D` with `BoxMesh`,
   `CapsuleMesh`, `CylinderMesh`, `SphereMesh`, `PlaneMesh`, `PrismMesh`,
   `TorusMesh`; `CSGBox3D`/`CSGCombiner3D` for carved level geometry
   (CSG has `use_collision`). Offline, set via a script in `_ready`
   (`mesh = BoxMesh.new(); mesh.size = Vector3(2,1,2)`) or in live mode
   `node.set {props:{"mesh": {"$var":"SubResource(...)"}}}`.
2. **Provider `asset` op** for parametric geometry that primitives can't do:
   terrain, stairs, ramps, arches, pipes, lathed props (bottles, pillars),
   extruded floor plans, composite pieces (`parts`). Produces OBJ (+MTL).
3. **CC0 libraries**: `discover {source:polyhaven, query:"rock"}` → `discover
   {source:"polyhaven-files", id}` → `asset {kind:"download", url, dir}` for
   the gltf and each `include` file. Kenney / Quaternius packs: download the
   zip via Bash and extract into `res://assets/models/<pack>/`.
4. **Blender headless** when installed (`blender -b -P script.py`): import,
   decimate, bake, export glTF. Write the Python with Blender's `bpy`; call it
   with the Bash tool. Use for cleanup of downloaded models or for sculpt-like
   procedural work (modifiers: displace, array, boolean).
5. **Generative 3D** (image/text → mesh, e.g. TripoSR, Hunyuan3D, Meshy API):
   produce a glb, then run it through Blender decimation (< 20k tris for a
   prop) before import. Treat results as a base to retopo, not final.

Always check the license before shipping an asset; write it to
`res://assets/CREDITS.md`.

## Import rules (Godot 4)

- Drop files under `res://`; Godot imports on the next editor scan or a
  headless `check` (which runs `--headless` and imports). glTF (`.glb/.gltf`)
  is the first-class format: materials, skins, animations, lights. OBJ is
  geometry + basic MTL only. FBX needs the FBX2glTF/ufbx importer (4.3+ has
  ufbx built-in).
- A model file imports as a **PackedScene**; instance it (`scene.instance
  {scene:"res://assets/models/tree.glb"}`) or extract the mesh (import dock →
  "Save to file", or at runtime `load(path).instantiate().get_child(0).mesh`).
- Name suffixes in the source file drive the importer: `-col` (static trimesh),
  `-convcol`, `-colonly` (collision, no visual), `-rigid`, `-navmesh`, `-noimp`,
  `-loop` on animations. The provider's `asset collision:` option sets these.
- Scale: glTF is in metres. If a model comes in 100× too big (cm export), set
  the import `scale` to 0.01, not the node scale.
- Materials: embedded glTF materials become `StandardMaterial3D`; to edit,
  set the import option "Materials → Extract" or override with
  `MeshInstance3D.material_override` / `set_surface_override_material(i, mat)`.
- Textures: PNG/JPG/WebP; enable `mipmaps` in import; for pixel art set
  `filter` nearest on the texture or via project `textures/canvas_textures/default_texture_filter`.

## Materials (StandardMaterial3D)

Set in script or via `node.set` on a material resource:
`albedo_color`, `albedo_texture`, `metallic`, `roughness`, `normal_enabled` +
`normal_texture`, `emission_enabled` + `emission` + `emission_energy_multiplier`,
`transparency = TRANSPARENCY_ALPHA`, `cull_mode = CULL_DISABLED` for foliage,
`uv1_triplanar = true` for generated terrain (no UV seams), `uv1_scale`.
Shaders: `ShaderMaterial` + `.gdshader` (`shader_type spatial;`); grab
proven ones from godotshaders.com (`discover {source:sources, query:"shader"}`).

Quick toon: `StandardMaterial3D` with `diffuse_mode = DIFFUSE_TOON`,
`specular_mode = SPECULAR_TOON`.

## Lighting & environment (so screenshots don't look flat)

- `DirectionalLight3D` (sun) with `shadow_enabled`, rotation ~(-45°, 30°, 0).
- `WorldEnvironment` with an `Environment`: `background_mode = SKY`, a
  `ProceduralSkyMaterial` or a Poly Haven HDRI (`PanoramaSkyMaterial`),
  `ambient_light_source = SKY`, `tonemap_mode = TONEMAP_ACES`, `glow_enabled`
  for emissives, `ssao_enabled` for contact shadows, `fog_enabled` for depth.
- For `gl_compatibility` renderer (mobile/web/old GPUs) skip SSAO/SDFGI;
  keep shadow maps small.
- Mobile/web: `rendering/renderer/rendering_method = "mobile"`.

## Collision for models

- Static props/level: instance with `-col` naming, or in script
  `$Mesh.create_trimesh_collision()` (adds StaticBody3D + shape as children).
- Dynamic props: `create_convex_collision()` (or `-convcol`), or hand-place a
  `BoxShape3D`/`CapsuleShape3D` roughly matching the silhouette (cheaper,
  more robust).
- Characters: capsule on the body; the model is a visual child with no collision.
- Terrain from the provider: trimesh static (the `terrain-script` option
  builds it live in the editor and rebuilds on parameter change).

## Procedural meshes in GDScript

```gdscript
var st := SurfaceTool.new()
st.begin(Mesh.PRIMITIVE_TRIANGLES)
st.set_material(mat)
for v in verts: st.set_uv(uv); st.set_normal(n); st.add_vertex(v)
for i in indices: st.add_index(i)
st.generate_normals()     # if you didn't set them
st.generate_tangents()    # needed for normal maps
mesh_instance.mesh = st.commit()
```
`ArrayMesh.add_surface_from_arrays` for raw arrays (faster for big grids);
`ImmediateMesh` for debug lines; `MultiMeshInstance3D` for thousands of
instances (grass, rocks) with `multimesh.set_instance_transform(i, t)`.
Marching cubes / voxels: generate per chunk (16³), one ArrayMesh per chunk,
rebuild only dirty chunks, collision via `create_trimesh_shape()`.

## Characters & animation

- Rigged humanoids: Mixamo (download FBX → convert to glb via Blender or use
  the ufbx importer), Quaternius packs (glb, animated). Import with
  "Skeleton → Retarget → Bone map: SkeletonProfileHumanoid" so any humanoid
  animation plays on any humanoid.
- Play: `AnimationPlayer.play("walk")`; blend with `AnimationTree`
  (`BlendSpace1D` on speed). Root motion: enable in the AnimationTree and
  apply `tree.get_root_motion_position()` to velocity.
- Sprites in 3D (2.5D): `Sprite3D` + `billboard = BILLBOARD_ENABLED`, pixel size
  0.01–0.02, `texture_filter` nearest.

## Verify assets

After generating/downloading: `check` (imports), then a scene that instances
the asset, then `run` with `{screenshot:"asset"}` and *look at it*: scale,
orientation (Godot: -Z forward, Y up; models often come +Z/+Y swapped — fix
with the import "Up axis"/rotation, not per-node), missing textures (magenta
= missing shader, white = missing texture), inverted normals (inside-out
look → `cull_mode`, or recompute normals in Blender).
