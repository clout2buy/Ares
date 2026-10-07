# Ares Bridge — editor side. Exposes the live scene tree, node/script/signal
# editing, input-map and project-setting edits, viewport screenshots and
# play/stop over a loopback RPC so Ares works inside the editor you are
# watching instead of guessing from .tscn text.
#
# Port: res://.ares/godot.json {"bridgePort": N}, else ProjectSettings
# "ares/bridge/port", else 6505. The in-game runtime autoload is registered
# here so `run` sessions can be driven and screenshotted.
@tool
extends EditorPlugin

const Rpc = preload("res://addons/ares_bridge/ares_rpc.gd")
const AUTOLOAD_NAME := "AresRuntime"
const AUTOLOAD_PATH := "res://addons/ares_bridge/ares_runtime.gd"
const DEFAULT_PORT := 6505

var rpc
var port := DEFAULT_PORT


func _enter_tree() -> void:
	port = _read_port()
	rpc = Rpc.new()
	var err: Error = rpc.start(port, Callable(self, "_dispatch"))
	if err != OK:
		push_warning("Ares bridge: could not listen on 127.0.0.1:%d (%s)" % [port, error_string(err)])
	else:
		print("Ares bridge listening on 127.0.0.1:%d" % port)
	if not ProjectSettings.has_setting("autoload/" + AUTOLOAD_NAME):
		add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)
	set_process(true)


func _exit_tree() -> void:
	if rpc != null:
		rpc.stop()
		rpc = null
	if ProjectSettings.has_setting("autoload/" + AUTOLOAD_NAME):
		remove_autoload_singleton(AUTOLOAD_NAME)


func _process(_delta: float) -> void:
	if rpc != null:
		rpc.poll()


func _read_port() -> int:
	var cfg_path := "res://.ares/godot.json"
	if FileAccess.file_exists(cfg_path):
		var f := FileAccess.open(cfg_path, FileAccess.READ)
		if f != null:
			var json := JSON.new()
			if json.parse(f.get_as_text()) == OK and typeof(json.data) == TYPE_DICTIONARY:
				var p = json.data.get("bridgePort", 0)
				if int(p) > 0:
					return int(p)
	if ProjectSettings.has_setting("ares/bridge/port"):
		return int(ProjectSettings.get_setting("ares/bridge/port"))
	return DEFAULT_PORT


# ---- dispatch ---------------------------------------------------------------

func _dispatch(method: String, params: Dictionary) -> Dictionary:
	match method:
		"ping":
			return _ok({
				"side": "editor",
				"godot": Engine.get_version_info().get("string", ""),
				"project": ProjectSettings.get_setting("application/config/name", ""),
				"scene": _scene_path(),
				"open_scenes": Array(EditorInterface.get_open_scenes()),
				"playing": EditorInterface.is_playing_scene(),
				"playing_scene": EditorInterface.get_playing_scene(),
			})
		"scene.tree":
			return _scene_tree(params)
		"scene.open":
			return _scene_open(params)
		"scene.save":
			return _scene_save(params)
		"scene.save_as":
			return _scene_save_as(params)
		"scene.new":
			return _scene_new(params)
		"scene.instance":
			return _scene_instance(params)
		"scene.reload":
			EditorInterface.reload_scene_from_path(_scene_path())
			return _ok({"scene": _scene_path()})
		"node.add":
			return _node_add(params)
		"node.remove":
			return _node_remove(params)
		"node.set":
			return _node_set(params)
		"node.get":
			return _node_get(params)
		"node.call":
			return _node_call(params)
		"node.rename":
			return _node_rename(params)
		"node.reparent":
			return _node_reparent(params)
		"node.find":
			return _node_find(params)
		"script.attach":
			return _script_attach(params)
		"script.detach":
			return _script_detach(params)
		"script.create":
			return _script_create(params)
		"script.read":
			return _file_read(params)
		"signal.connect":
			return _signal_connect(params)
		"signal.disconnect":
			return _signal_disconnect(params)
		"signal.list":
			return _signal_list(params)
		"editor.screenshot":
			return _editor_screenshot(params)
		"editor.play":
			return _editor_play(params)
		"editor.stop":
			EditorInterface.stop_playing_scene()
			return _ok({"playing": false})
		"editor.scan":
			EditorInterface.get_resource_filesystem().scan()
			return _ok({"scanned": true})
		"editor.focus":
			return _editor_focus(params)
		"editor.selection":
			return _editor_selection()
		"project.get":
			var key := str(params.get("key", ""))
			return _ok({"key": key, "value": Rpc.to_json(ProjectSettings.get_setting(key)) if ProjectSettings.has_setting(key) else null})
		"project.set":
			return _project_set(params)
		"input.add":
			return _input_add(params)
		"input.remove":
			return _input_remove(params)
		"input.list":
			return _input_list()
		"res.list":
			return _res_list(params)
		"res.exists":
			return _ok({"path": params.get("path", ""), "exists": ResourceLoader.exists(str(params.get("path", "")))})
		"class.info":
			return _class_info(params)
		_:
			return _err("unknown editor method: " + method)


func _ok(result) -> Dictionary:
	return {"ok": true, "result": result}


func _err(message: String) -> Dictionary:
	return {"ok": false, "error": message}


func _scene_path() -> String:
	var root := EditorInterface.get_edited_scene_root()
	return root.scene_file_path if root != null else ""


func _root() -> Node:
	return EditorInterface.get_edited_scene_root()


func _find(path_text) -> Node:
	var root := _root()
	if root == null:
		return null
	var p := str(path_text)
	if p == "" or p == "." or p == "/" or p == root.name:
		return root
	if p.begins_with("@"):
		p = p.substr(1)
	if p.begins_with("/root/"):
		var n := root.get_tree().root.get_node_or_null(NodePath(p))
		if n != null:
			return n
	var rel := root.get_node_or_null(NodePath(p))
	if rel != null:
		return rel
	# tolerate "Root/Child" written with the root name as first segment
	var first := p.get_slice("/", 0)
	if first == root.name and p.length() > first.length():
		return root.get_node_or_null(NodePath(p.substr(first.length() + 1)))
	return null


func _mark_dirty() -> void:
	EditorInterface.mark_scene_as_unsaved()


# ---- scenes --------------------------------------------------------------

func _scene_tree(params: Dictionary) -> Dictionary:
	var want := str(params.get("path", ""))
	if want != "" and want != _scene_path():
		var r := _scene_open({"path": want})
		if not r.ok:
			return r
	var root := _root()
	if root == null:
		return _err("no scene is open in the editor (pass path or use scene.open)")
	var max_depth := int(params.get("depth", 12))
	return _ok({"scene": root.scene_file_path, "tree": Rpc.node_info(root, root, 0, max_depth)})


func _scene_open(params: Dictionary) -> Dictionary:
	var p := str(params.get("path", ""))
	if not ResourceLoader.exists(p):
		return _err("scene does not exist: " + p)
	EditorInterface.open_scene_from_path(p)
	return _ok({"scene": _scene_path()})


func _scene_save(_params: Dictionary) -> Dictionary:
	var err := EditorInterface.save_scene()
	if err != OK:
		return _err("save failed: " + error_string(err))
	return _ok({"scene": _scene_path()})


func _scene_save_as(params: Dictionary) -> Dictionary:
	var p := str(params.get("path", ""))
	if p == "":
		return _err("path required")
	_ensure_dir(p.get_base_dir())
	EditorInterface.save_scene_as(p, bool(params.get("open", true)))
	EditorInterface.get_resource_filesystem().scan()
	return _ok({"scene": p})


func _scene_new(params: Dictionary) -> Dictionary:
	var type := str(params.get("root_type", "Node3D"))
	var name := str(params.get("name", "Main"))
	var p := str(params.get("path", ""))
	if p == "":
		return _err("path required (res://scenes/x.tscn)")
	var root := _instantiate_type(type)
	if root == null:
		return _err("cannot instantiate root type: " + type)
	root.name = name
	var packed := PackedScene.new()
	var perr := packed.pack(root)
	if perr != OK:
		return _err("pack failed: " + error_string(perr))
	_ensure_dir(p.get_base_dir())
	var serr := ResourceSaver.save(packed, p)
	root.free()
	if serr != OK:
		return _err("save failed: " + error_string(serr))
	EditorInterface.get_resource_filesystem().scan()
	if bool(params.get("open", true)):
		EditorInterface.open_scene_from_path(p)
	if bool(params.get("main", false)):
		ProjectSettings.set_setting("application/run/main_scene", p)
		ProjectSettings.save()
	return _ok({"scene": p})


func _scene_instance(params: Dictionary) -> Dictionary:
	var root := _root()
	if root == null:
		return _err("no scene open")
	var parent := _find(params.get("parent", "."))
	if parent == null:
		return _err("parent not found: " + str(params.get("parent")))
	var scene_path := str(params.get("scene", ""))
	if not ResourceLoader.exists(scene_path):
		return _err("scene not found: " + scene_path)
	var packed = load(scene_path)
	var node: Node = packed.instantiate()
	if params.has("name"):
		node.name = str(params["name"])
	parent.add_child(node, true)
	node.owner = root
	var props = params.get("props", {})
	if typeof(props) == TYPE_DICTIONARY:
		_apply_props(node, props)
	_mark_dirty()
	return _ok({"path": str(root.get_path_to(node)), "type": node.get_class()})


# ---- nodes ---------------------------------------------------------------

func _instantiate_type(type: String) -> Node:
	if type.ends_with(".tscn") or type.begins_with("res://"):
		if ResourceLoader.exists(type):
			return load(type).instantiate()
		return null
	if ClassDB.class_exists(type) and ClassDB.can_instantiate(type):
		var obj = ClassDB.instantiate(type)
		if obj is Node:
			return obj
	return null


func _node_add(params: Dictionary) -> Dictionary:
	var root := _root()
	if root == null:
		return _err("no scene open")
	var parent := _find(params.get("parent", "."))
	if parent == null:
		return _err("parent not found: " + str(params.get("parent")))
	var type := str(params.get("type", "Node"))
	var node := _instantiate_type(type)
	if node == null:
		return _err("cannot instantiate type: " + type + " (check ClassDB name, e.g. CharacterBody3D, MeshInstance3D)")
	if params.has("name"):
		node.name = str(params["name"])
	parent.add_child(node, true)
	node.owner = root
	# nodes created from a scene must have every descendant owned to persist
	_own_recursive(node, root)
	var warnings := []
	var props = params.get("props", {})
	if typeof(props) == TYPE_DICTIONARY:
		warnings = _apply_props(node, props)
	if params.has("script"):
		var s = load(str(params["script"]))
		if s != null:
			node.set_script(s)
	_mark_dirty()
	return _ok({"path": str(root.get_path_to(node)), "type": node.get_class(), "warnings": warnings})


func _own_recursive(node: Node, root: Node) -> void:
	for c in node.get_children():
		if c.owner == null:
			c.owner = root
		_own_recursive(c, root)


func _apply_props(node: Object, props: Dictionary) -> Array:
	var warnings := []
	for k in props.keys():
		var pname := str(k)
		var hint := Rpc.property_type(node, pname)
		var value = Rpc.from_json(props[k], hint)
		if pname.find("/") >= 0 or pname.find(":") >= 0:
			node.set_indexed(NodePath(pname), value)
		else:
			node.set(pname, value)
		var back = node.get(pname) if pname.find("/") < 0 else node.get_indexed(NodePath(pname))
		if hint != TYPE_NIL and typeof(back) == TYPE_NIL and value != null:
			warnings.append("property may not exist: " + pname)
	return warnings


func _node_remove(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found: " + str(params.get("path")))
	if node == _root():
		return _err("refusing to remove the scene root")
	var p := str(_root().get_path_to(node))
	node.get_parent().remove_child(node)
	node.queue_free()
	_mark_dirty()
	return _ok({"removed": p})


func _node_set(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found: " + str(params.get("path")))
	var props = params.get("props", {})
	if typeof(props) != TYPE_DICTIONARY:
		return _err("props must be an object")
	var warnings := _apply_props(node, props)
	_mark_dirty()
	return _ok({"path": str(_root().get_path_to(node)), "props": Rpc.editor_properties(node, props.keys()), "warnings": warnings})


func _node_get(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found: " + str(params.get("path")))
	var names = params.get("props", [])
	if typeof(names) != TYPE_ARRAY:
		names = []
	var out := {
		"path": str(_root().get_path_to(node)),
		"type": node.get_class(),
		"props": Rpc.editor_properties(node, names),
	}
	var script = node.get_script()
	if script != null and script.resource_path != "":
		out["script"] = script.resource_path
	return _ok(out)


func _node_call(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found: " + str(params.get("path")))
	var method := str(params.get("method", ""))
	if not node.has_method(method):
		return _err("no method %s on %s" % [method, node.get_class()])
	var args = params.get("args", [])
	if typeof(args) != TYPE_ARRAY:
		args = [args]
	var conv := []
	for a in args:
		conv.append(Rpc.from_json(a))
	var result = node.callv(method, conv)
	_mark_dirty()
	return _ok({"result": Rpc.to_json(result)})


func _node_rename(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found")
	node.name = str(params.get("name", node.name))
	_mark_dirty()
	return _ok({"path": str(_root().get_path_to(node))})


func _node_reparent(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	var parent := _find(params.get("new_parent", "."))
	if node == null or parent == null:
		return _err("node or new_parent not found")
	node.reparent(parent, bool(params.get("keep_global", true)))
	node.owner = _root()
	_mark_dirty()
	return _ok({"path": str(_root().get_path_to(node))})


func _node_find(params: Dictionary) -> Dictionary:
	var root := _root()
	if root == null:
		return _err("no scene open")
	var pattern := str(params.get("pattern", "*"))
	var type := str(params.get("type", ""))
	var found := root.find_children(pattern, type, true, false)
	var out := []
	for n in found:
		out.append({"path": str(root.get_path_to(n)), "type": n.get_class()})
	return _ok({"nodes": out})


# ---- scripts & signals ----------------------------------------------------

func _script_attach(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found: " + str(params.get("path")))
	var sp := str(params.get("script", ""))
	if not ResourceLoader.exists(sp):
		EditorInterface.get_resource_filesystem().scan()
	var s = load(sp)
	if s == null:
		return _err("script not found: " + sp)
	node.set_script(s)
	_mark_dirty()
	return _ok({"path": str(_root().get_path_to(node)), "script": sp})


func _script_detach(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found")
	node.set_script(null)
	_mark_dirty()
	return _ok({"path": str(_root().get_path_to(node))})


func _script_create(params: Dictionary) -> Dictionary:
	var p := str(params.get("path", ""))
	var content := str(params.get("content", ""))
	if p == "":
		return _err("path required")
	_ensure_dir(p.get_base_dir())
	var f := FileAccess.open(p, FileAccess.WRITE)
	if f == null:
		return _err("cannot write " + p + ": " + error_string(FileAccess.get_open_error()))
	f.store_string(content)
	f.close()
	EditorInterface.get_resource_filesystem().update_file(p)
	var out := {"path": p, "bytes": content.length()}
	if params.has("attach_to"):
		var r := _script_attach({"path": params["attach_to"], "script": p})
		out["attached"] = r.ok
		if not r.ok:
			out["attach_error"] = r.error
	return _ok(out)


func _file_read(params: Dictionary) -> Dictionary:
	var p := str(params.get("path", ""))
	if not FileAccess.file_exists(p):
		return _err("file not found: " + p)
	var f := FileAccess.open(p, FileAccess.READ)
	return _ok({"path": p, "content": f.get_as_text()})


func _signal_connect(params: Dictionary) -> Dictionary:
	var from := _find(params.get("from", ""))
	var to := _find(params.get("to", ""))
	if from == null or to == null:
		return _err("from/to node not found")
	var sig := str(params.get("signal", ""))
	var method := str(params.get("method", ""))
	if not from.has_signal(sig):
		return _err("%s has no signal %s" % [from.get_class(), sig])
	var callable := Callable(to, method)
	if from.is_connected(sig, callable):
		return _ok({"already": true})
	var err := from.connect(sig, callable, CONNECT_PERSIST)
	if err != OK:
		return _err("connect failed: " + error_string(err))
	_mark_dirty()
	return _ok({"from": str(_root().get_path_to(from)), "signal": sig, "to": str(_root().get_path_to(to)), "method": method})


func _signal_disconnect(params: Dictionary) -> Dictionary:
	var from := _find(params.get("from", ""))
	var to := _find(params.get("to", ""))
	if from == null or to == null:
		return _err("from/to node not found")
	var sig := str(params.get("signal", ""))
	var callable := Callable(to, str(params.get("method", "")))
	if from.is_connected(sig, callable):
		from.disconnect(sig, callable)
	_mark_dirty()
	return _ok({"disconnected": true})


func _signal_list(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found")
	var sigs := []
	for s in node.get_signal_list():
		var name := str(s.get("name", ""))
		var conns := []
		for c in node.get_signal_connection_list(name):
			var cal: Callable = c.get("callable")
			conns.append({"to": Rpc.to_json(cal.get_object()), "method": str(cal.get_method())})
		sigs.append({"name": name, "connections": conns})
	return _ok({"path": str(_root().get_path_to(node)), "signals": sigs})


# ---- editor ---------------------------------------------------------------

func _editor_screenshot(params: Dictionary) -> Dictionary:
	var file := str(params.get("file", ""))
	if file == "":
		return _err("file required (absolute path)")
	var view := str(params.get("view", "3d"))
	var idx := int(params.get("index", 0))
	var vp: Viewport
	if view == "2d":
		vp = EditorInterface.get_editor_viewport_2d()
	else:
		vp = EditorInterface.get_editor_viewport_3d(idx)
	if vp == null:
		return _err("viewport unavailable: " + view)
	var tex := vp.get_texture()
	if tex == null:
		return _err("viewport has no texture yet")
	var img := tex.get_image()
	if img == null or img.is_empty():
		return _err("viewport image is empty (editor not drawn yet?)")
	_ensure_dir(file.get_base_dir())
	var err := img.save_png(file)
	if err != OK:
		return _err("save_png failed: " + error_string(err))
	return _ok({"file": file, "width": img.get_width(), "height": img.get_height(), "view": view})


func _editor_play(params: Dictionary) -> Dictionary:
	var scene := str(params.get("scene", ""))
	if scene == "":
		EditorInterface.play_main_scene()
	elif scene == "current":
		EditorInterface.play_current_scene()
	else:
		EditorInterface.play_custom_scene(scene)
	return _ok({"playing": true})


func _editor_focus(params: Dictionary) -> Dictionary:
	var node := _find(params.get("path", ""))
	if node == null:
		return _err("node not found")
	EditorInterface.edit_node(node)
	var sel := EditorInterface.get_selection()
	sel.clear()
	sel.add_node(node)
	return _ok({"focused": str(_root().get_path_to(node))})


func _editor_selection() -> Dictionary:
	var out := []
	var root := _root()
	for n in EditorInterface.get_selection().get_selected_nodes():
		out.append({"path": str(root.get_path_to(n)) if root else str(n.get_path()), "type": n.get_class()})
	return _ok({"selected": out})


# ---- project / input ------------------------------------------------------

func _project_set(params: Dictionary) -> Dictionary:
	var key := str(params.get("key", ""))
	if key == "":
		return _err("key required")
	ProjectSettings.set_setting(key, Rpc.from_json(params.get("value")))
	var err := ProjectSettings.save()
	if err != OK:
		return _err("ProjectSettings.save failed: " + error_string(err))
	return _ok({"key": key, "value": Rpc.to_json(ProjectSettings.get_setting(key))})


func _input_add(params: Dictionary) -> Dictionary:
	var action := str(params.get("action", ""))
	if action == "":
		return _err("action required")
	var events := []
	for k in params.get("keys", []):
		var ev := InputEventKey.new()
		var code := OS.find_keycode_from_string(str(k))
		if code == KEY_NONE:
			return _err("unknown key name: " + str(k))
		if bool(params.get("physical", true)):
			ev.physical_keycode = code
		else:
			ev.keycode = code
		events.append(ev)
	for b in params.get("mouse_buttons", []):
		var ev := InputEventMouseButton.new()
		ev.button_index = int(b)
		events.append(ev)
	for b in params.get("joy_buttons", []):
		var ev := InputEventJoypadButton.new()
		ev.button_index = int(b)
		events.append(ev)
	for a in params.get("joy_axes", []):
		var ev := InputEventJoypadMotion.new()
		ev.axis = int(a.get("axis", 0))
		ev.axis_value = float(a.get("value", 1.0))
		events.append(ev)
	var existing = ProjectSettings.get_setting("input/" + action, null)
	if typeof(existing) == TYPE_DICTIONARY and bool(params.get("append", false)):
		var prev: Array = existing.get("events", [])
		prev.append_array(events)
		events = prev
	ProjectSettings.set_setting("input/" + action, {"deadzone": float(params.get("deadzone", 0.5)), "events": events})
	var err := ProjectSettings.save()
	if err != OK:
		return _err("ProjectSettings.save failed: " + error_string(err))
	return _ok({"action": action, "events": events.size()})


func _input_remove(params: Dictionary) -> Dictionary:
	var action := str(params.get("action", ""))
	ProjectSettings.set_setting("input/" + action, null)
	ProjectSettings.save()
	return _ok({"removed": action})


func _input_list() -> Dictionary:
	var out := {}
	for p in ProjectSettings.get_property_list():
		var name := str(p.get("name", ""))
		if not name.begins_with("input/"):
			continue
		var v = ProjectSettings.get_setting(name)
		var evs := []
		if typeof(v) == TYPE_DICTIONARY:
			for ev in v.get("events", []):
				evs.append(ev.as_text() if ev != null else "")
		out[name.substr(6)] = evs
	return _ok({"actions": out})


func _res_list(params: Dictionary) -> Dictionary:
	var dir := str(params.get("dir", "res://"))
	var exts: Array = params.get("exts", [])
	var recursive := bool(params.get("recursive", true))
	var out := []
	_walk(dir, exts, recursive, out, 0)
	return _ok({"dir": dir, "files": out})


func _walk(dir: String, exts: Array, recursive: bool, out: Array, depth: int) -> void:
	if depth > 16 or out.size() > 4000:
		return
	var d := DirAccess.open(dir)
	if d == null:
		return
	d.list_dir_begin()
	var name := d.get_next()
	while name != "":
		if name.begins_with(".") or name == "addons" and depth == 0 and not bool(exts.has("addons")):
			name = d.get_next()
			continue
		var full := dir.path_join(name)
		if d.current_is_dir():
			if recursive:
				_walk(full, exts, recursive, out, depth + 1)
		else:
			if name.ends_with(".import") or name.ends_with(".uid"):
				name = d.get_next()
				continue
			if exts.is_empty() or exts.has(name.get_extension()):
				out.append(full)
		name = d.get_next()
	d.list_dir_end()


func _class_info(params: Dictionary) -> Dictionary:
	var cls := str(params.get("class", ""))
	if not ClassDB.class_exists(cls):
		return _err("unknown class: " + cls)
	var props := []
	for p in ClassDB.class_get_property_list(cls, false):
		var usage: int = p.get("usage", 0)
		if usage & PROPERTY_USAGE_EDITOR and not (usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP):
			props.append(str(p.get("name")))
	var methods := []
	for m in ClassDB.class_get_method_list(cls, false):
		methods.append(str(m.get("name")))
	var sigs := []
	for s in ClassDB.class_get_signal_list(cls, false):
		sigs.append(str(s.get("name")))
	return _ok({
		"class": cls,
		"parent": ClassDB.get_parent_class(cls),
		"properties": props,
		"methods": methods,
		"signals": sigs,
	})


func _ensure_dir(dir: String) -> void:
	if dir == "" or dir == "res://":
		return
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(dir) if dir.begins_with("res://") else dir)
