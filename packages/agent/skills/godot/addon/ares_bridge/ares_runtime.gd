# Ares Runtime — in-game side. Registered as the AresRuntime autoload by the
# bridge plugin. It is inert unless the process was launched with
# ARES_GODOT_RUNTIME=1, so normal play and exports are untouched.
#
# Lets Ares drive and observe a running game: press/hold input actions,
# inject key/mouse events, read node and physics state, take viewport
# screenshots, change scenes, scale time, pause, and quit — the loop behind
# "does the jump actually feel right" instead of "the script compiled".
extends Node

const Rpc = preload("res://addons/ares_bridge/ares_rpc.gd")
const DEFAULT_PORT := 6506

var rpc
var _releases: Array = []   # [{at: msec, action|event}]
var _log: Array = []


func _ready() -> void:
	if OS.get_environment("ARES_GODOT_RUNTIME") != "1":
		set_process(false)
		return
	var port := int(OS.get_environment("ARES_GODOT_RUNTIME_PORT"))
	if port <= 0:
		port = DEFAULT_PORT
	process_mode = Node.PROCESS_MODE_ALWAYS
	rpc = Rpc.new()
	var err: Error = rpc.start(port, Callable(self, "_dispatch"))
	if err != OK:
		push_error("Ares runtime: could not listen on %d (%s)" % [port, error_string(err)])
	else:
		print("Ares runtime listening on 127.0.0.1:%d" % port)


func _process(_delta: float) -> void:
	if rpc != null:
		rpc.poll()
	if _releases.is_empty():
		return
	var now := Time.get_ticks_msec()
	for i in range(_releases.size() - 1, -1, -1):
		var r: Dictionary = _releases[i]
		if now >= int(r.at):
			if r.has("action"):
				Input.action_release(r.action)
			elif r.has("event"):
				var ev: InputEvent = r.event
				ev.pressed = false
				Input.parse_input_event(ev)
			_releases.remove_at(i)


func _dispatch(method: String, params: Dictionary) -> Dictionary:
	match method:
		"ping":
			var cs := get_tree().current_scene
			return _ok({
				"side": "runtime",
				"scene": cs.scene_file_path if cs else "",
				"fps": Engine.get_frames_per_second(),
				"frame": Engine.get_process_frames(),
				"time_scale": Engine.time_scale,
				"paused": get_tree().paused,
				"window": Rpc.to_json(get_viewport().get_visible_rect().size),
			})
		"screenshot":
			return _screenshot(params)
		"input.press":
			return _press(params)
		"input.release":
			Input.action_release(str(params.get("action", "")))
			return _ok({"released": params.get("action", "")})
		"input.key":
			return _key(params)
		"input.mouse":
			return _mouse(params)
		"input.axis":
			var action := str(params.get("action", ""))
			Input.action_press(action, float(params.get("strength", 1.0)))
			return _ok({"action": action, "strength": params.get("strength", 1.0)})
		"input.release_all":
			for r in _releases:
				if r.has("action"):
					Input.action_release(r.action)
			_releases.clear()
			return _ok({"released": true})
		"node.get":
			return _node_get(params)
		"node.set":
			return _node_set(params)
		"node.call":
			return _node_call(params)
		"node.find":
			return _node_find(params)
		"scene.tree":
			var root := get_tree().current_scene
			if root == null:
				return _err("no current scene")
			return _ok({"scene": root.scene_file_path, "tree": Rpc.node_info(root, root, 0, int(params.get("depth", 8)))})
		"scene.change":
			var p := str(params.get("path", ""))
			var err := get_tree().change_scene_to_file(p)
			if err != OK:
				return _err("change_scene failed: " + error_string(err))
			return _ok({"scene": p})
		"scene.reload":
			get_tree().reload_current_scene()
			return _ok({"reloaded": true})
		"physics.state":
			return _physics_state(params)
		"stats":
			return _stats()
		"time.scale":
			Engine.time_scale = float(params.get("value", 1.0))
			return _ok({"time_scale": Engine.time_scale})
		"pause":
			get_tree().paused = bool(params.get("value", true))
			return _ok({"paused": get_tree().paused})
		"wait":
			# the Node side sleeps; this just reports the frame so it can confirm progress
			return _ok({"frame": Engine.get_process_frames()})
		"quit":
			get_tree().quit()
			return _ok({"quit": true})
		_:
			return _err("unknown runtime method: " + method)


func _ok(result) -> Dictionary:
	return {"ok": true, "result": result}


func _err(message: String) -> Dictionary:
	return {"ok": false, "error": message}


func _find(path_text) -> Node:
	var p := str(path_text)
	var root := get_tree().current_scene
	if p == "" or p == ".":
		return root
	if p.begins_with("@"):
		p = p.substr(1)
	if p.begins_with("/root"):
		return get_tree().root.get_node_or_null(NodePath(p))
	if root == null:
		return null
	var n := root.get_node_or_null(NodePath(p))
	if n != null:
		return n
	var first := p.get_slice("/", 0)
	if first == root.name and p.length() > first.length():
		return root.get_node_or_null(NodePath(p.substr(first.length() + 1)))
	# last resort: unique name / find by name anywhere
	var found := root.find_children(p.get_file(), "", true, false)
	return found[0] if found.size() > 0 else null


func _screenshot(params: Dictionary) -> Dictionary:
	var file := str(params.get("file", ""))
	if file == "":
		return _err("file required")
	var img := get_viewport().get_texture().get_image()
	if img == null or img.is_empty():
		return _err("viewport image empty")
	DirAccess.make_dir_recursive_absolute(file.get_base_dir())
	var err := img.save_png(file)
	if err != OK:
		return _err("save_png failed: " + error_string(err))
	return _ok({"file": file, "width": img.get_width(), "height": img.get_height(), "frame": Engine.get_process_frames()})


func _press(params: Dictionary) -> Dictionary:
	var actions = params.get("actions", null)
	if actions == null:
		actions = [params.get("action", "")]
	var ms := int(params.get("ms", 100))
	var strength := float(params.get("strength", 1.0))
	var missing := []
	for a in actions:
		var action := str(a)
		if not InputMap.has_action(action):
			missing.append(action)
			continue
		Input.action_press(action, strength)
		if ms > 0:
			_releases.append({"at": Time.get_ticks_msec() + ms, "action": action})
	if missing.size() > 0:
		return _err("unknown input actions: " + ", ".join(missing) + " (see input.list / InputMap)")
	return _ok({"pressed": actions, "ms": ms})


func _key(params: Dictionary) -> Dictionary:
	var key := str(params.get("key", ""))
	var code := OS.find_keycode_from_string(key)
	if code == KEY_NONE:
		return _err("unknown key: " + key)
	var ev := InputEventKey.new()
	ev.keycode = code
	ev.physical_keycode = code
	ev.pressed = true
	Input.parse_input_event(ev)
	var ms := int(params.get("ms", 100))
	var rel := InputEventKey.new()
	rel.keycode = code
	rel.physical_keycode = code
	_releases.append({"at": Time.get_ticks_msec() + ms, "event": rel})
	return _ok({"key": key, "ms": ms})


func _mouse(params: Dictionary) -> Dictionary:
	var pos := Vector2(float(params.get("x", 0)), float(params.get("y", 0)))
	if params.get("relative", false):
		var mm := InputEventMouseMotion.new()
		mm.relative = pos
		mm.position = get_viewport().get_mouse_position() + pos
		Input.parse_input_event(mm)
		return _ok({"moved": Rpc.to_json(pos)})
	get_viewport().warp_mouse(pos)
	var motion := InputEventMouseMotion.new()
	motion.position = pos
	Input.parse_input_event(motion)
	if params.has("button"):
		var btn := InputEventMouseButton.new()
		btn.position = pos
		btn.button_index = int(params.get("button", 1))
		btn.pressed = true
		Input.parse_input_event(btn)
		var rel := InputEventMouseButton.new()
		rel.position = pos
		rel.button_index = btn.button_index
		_releases.append({"at": Time.get_ticks_msec() + int(params.get("ms", 80)), "event": rel})
	return _ok({"position": Rpc.to_json(pos)})


func _node_get(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found: " + str(params.get("path")))
	var names = params.get("props", [])
	if typeof(names) != TYPE_ARRAY:
		names = []
	return _ok({"path": str(node.get_path()), "type": node.get_class(), "props": Rpc.editor_properties(node, names)})


func _node_set(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found")
	var props = params.get("props", {})
	for k in props.keys():
		node.set(str(k), Rpc.from_json(props[k], Rpc.property_type(node, str(k))))
	return _ok({"path": str(node.get_path()), "props": Rpc.editor_properties(node, props.keys())})


func _node_call(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found")
	var method := str(params.get("method", ""))
	if not node.has_method(method):
		return _err("no method %s on %s" % [method, node.get_class()])
	var args = params.get("args", [])
	if typeof(args) != TYPE_ARRAY:
		args = [args]
	var conv := []
	for a in args:
		conv.append(Rpc.from_json(a))
	return _ok({"result": Rpc.to_json(node.callv(method, conv))})


func _node_find(params: Dictionary) -> Dictionary:
	var root := get_tree().current_scene
	if root == null:
		return _err("no current scene")
	var found := root.find_children(str(params.get("pattern", "*")), str(params.get("type", "")), true, false)
	var out := []
	for n in found:
		out.append({"path": str(root.get_path_to(n)), "type": n.get_class()})
	return _ok({"nodes": out})


func _physics_state(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found: " + str(params.get("path")))
	var out := {"path": str(node.get_path()), "type": node.get_class()}
	for prop in ["global_position", "position", "rotation", "velocity", "linear_velocity", "angular_velocity", "is_on_floor", "is_on_wall", "is_on_ceiling", "sleeping", "scale", "visible"]:
		if prop.begins_with("is_"):
			if node.has_method(prop):
				out[prop] = node.call(prop)
		else:
			var v = node.get(prop)
			if typeof(v) != TYPE_NIL:
				out[prop] = Rpc.to_json(v)
	if node is CollisionObject3D or node is CollisionObject2D:
		out["collision_layer"] = node.collision_layer
		out["collision_mask"] = node.collision_mask
	return _ok(out)


func _stats() -> Dictionary:
	return _ok({
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"process_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		"physics_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
		"objects": Performance.get_monitor(Performance.OBJECT_COUNT),
		"nodes": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"orphans": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		"primitives": Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME),
		"static_memory_mb": Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0,
		"physics_3d_active": Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS),
		"physics_2d_active": Performance.get_monitor(Performance.PHYSICS_2D_ACTIVE_OBJECTS),
	})
