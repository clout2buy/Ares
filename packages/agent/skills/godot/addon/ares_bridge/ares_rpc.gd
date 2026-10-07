# Ares RPC — a tiny newline-delimited JSON server over loopback TCP.
#
# Request:  {"id": 1, "method": "scene.tree", "params": {...}}\n
# Response: {"id": 1, "ok": true, "result": ...}\n  |  {"id": 1, "ok": false, "error": "..."}\n
#
# Shared by the editor plugin (bridge) and the in-game autoload (runtime).
# Binds 127.0.0.1 only. The dispatcher is a Callable(method: String,
# params: Dictionary) -> Dictionary with "ok" and "result" | "error".
extends RefCounted

var server := TCPServer.new()
var clients: Array = []
var dispatcher: Callable
var port: int = 0


func start(p: int, d: Callable) -> Error:
	dispatcher = d
	port = p
	return server.listen(p, "127.0.0.1")


func stop() -> void:
	for c in clients:
		c.peer.disconnect_from_host()
	clients.clear()
	if server.is_listening():
		server.stop()


func poll() -> void:
	while server.is_connection_available():
		var peer: StreamPeerTCP = server.take_connection()
		peer.set_no_delay(true)
		clients.append({"peer": peer, "buf": PackedByteArray()})
	for i in range(clients.size() - 1, -1, -1):
		var c: Dictionary = clients[i]
		var peer: StreamPeerTCP = c.peer
		peer.poll()
		var status := peer.get_status()
		if status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
			clients.remove_at(i)
			continue
		if status != StreamPeerTCP.STATUS_CONNECTED:
			continue
		var avail := peer.get_available_bytes()
		if avail <= 0:
			continue
		var chunk = peer.get_data(avail)
		if chunk[0] != OK:
			continue
		var buf: PackedByteArray = c.buf
		buf.append_array(chunk[1])
		while true:
			var nl := buf.find(10)
			if nl < 0:
				break
			var line_bytes := buf.slice(0, nl)
			buf = buf.slice(nl + 1)
			_handle_line(peer, line_bytes.get_string_from_utf8())
		c.buf = buf


func _handle_line(peer: StreamPeerTCP, line: String) -> void:
	if line.strip_edges().is_empty():
		return
	var json := JSON.new()
	var id = null
	var response: Dictionary
	if json.parse(line) != OK or typeof(json.data) != TYPE_DICTIONARY:
		response = {"id": id, "ok": false, "error": "bad request: " + json.get_error_message()}
	else:
		var req: Dictionary = json.data
		id = req.get("id")
		var method := str(req.get("method", ""))
		var params = req.get("params", {})
		if typeof(params) != TYPE_DICTIONARY:
			params = {}
		var out = dispatcher.call(method, params)
		if typeof(out) != TYPE_DICTIONARY:
			out = {"ok": true, "result": out}
		response = {"id": id, "ok": out.get("ok", true)}
		if out.has("error"):
			response["error"] = str(out["error"])
		if out.has("result"):
			response["result"] = out["result"]
	var text := JSON.stringify(response) + "\n"
	peer.put_data(text.to_utf8_buffer())


# ---- value conversion shared by both sides -------------------------------

static func to_json(v) -> Variant:
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return v
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(v)
		TYPE_ARRAY:
			var arr := []
			for item in v:
				arr.append(to_json(item))
			return arr
		TYPE_DICTIONARY:
			var d := {}
			for k in v.keys():
				d[str(k)] = to_json(v[k])
			return d
		TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_BYTE_ARRAY:
			return Array(v)
		TYPE_OBJECT:
			if v == null:
				return null
			if v is Node:
				return "@" + str(v.get_path())
			if v is Resource:
				return v.resource_path if v.resource_path != "" else "<" + v.get_class() + ">"
			return "<" + v.get_class() + ">"
		_:
			return var_to_str(v)


static func from_json(v, hint_type: int = TYPE_NIL) -> Variant:
	match typeof(v):
		TYPE_STRING:
			var s: String = v
			if s.begins_with("res://") or s.begins_with("uid://"):
				if hint_type == TYPE_OBJECT or hint_type == TYPE_NIL and ResourceLoader.exists(s):
					var r = load(s)
					if r != null:
						return r
				return s
			if _looks_like_variant(s):
				var parsed = str_to_var(s)
				if parsed != null:
					return parsed
			if hint_type == TYPE_NODE_PATH:
				return NodePath(s)
			if hint_type == TYPE_STRING_NAME:
				return StringName(s)
			return s
		TYPE_DICTIONARY:
			if v.has("$res"):
				return load(str(v["$res"]))
			if v.has("$var"):
				return str_to_var(str(v["$var"]))
			var d := {}
			for k in v.keys():
				d[k] = from_json(v[k])
			return d
		TYPE_ARRAY:
			var arr := []
			for item in v:
				arr.append(from_json(item))
			if hint_type == TYPE_PACKED_STRING_ARRAY:
				return PackedStringArray(arr)
			return arr
		TYPE_FLOAT:
			if hint_type == TYPE_INT:
				return int(v)
			return v
		_:
			return v


static func _looks_like_variant(s: String) -> bool:
	var re := RegEx.new()
	re.compile("^(Vector[234]i?|Color|Rect2i?|Transform[23]D|Basis|Quaternion|Plane|AABB|Projection|NodePath|StringName|Packed(Vector[23]|String|Float32|Float64|Int32|Int64|Byte|Color)Array)\\s*\\(")
	return re.search(s) != null


static func node_info(n: Node, root: Node, depth: int, max_depth: int) -> Dictionary:
	var info := {
		"name": n.name,
		"type": n.get_class(),
		"path": str(root.get_path_to(n)) if n != root else ".",
	}
	var script = n.get_script()
	if script != null and script is Resource and script.resource_path != "":
		info["script"] = script.resource_path
	if n.scene_file_path != "" and n != root:
		info["instance"] = n.scene_file_path
	var groups := []
	for g in n.get_groups():
		var gs := str(g)
		if not gs.begins_with("_"):
			groups.append(gs)
	if groups.size() > 0:
		info["groups"] = groups
	if n is Node3D:
		info["position"] = to_json(n.position)
	elif n is Node2D:
		info["position"] = to_json(n.position)
	elif n is Control:
		info["position"] = to_json(n.position)
		info["size"] = to_json(n.size)
	if depth < max_depth and n.get_child_count() > 0:
		var kids := []
		for c in n.get_children():
			kids.append(node_info(c, root, depth + 1, max_depth))
		info["children"] = kids
	elif n.get_child_count() > 0:
		info["child_count"] = n.get_child_count()
	return info


static func editor_properties(n: Object, names: Array = []) -> Dictionary:
	var out := {}
	if names.size() > 0:
		for name in names:
			out[str(name)] = to_json(n.get(str(name)))
		return out
	for p in n.get_property_list():
		var usage: int = p.get("usage", 0)
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP or usage & PROPERTY_USAGE_SUBGROUP:
			continue
		if not (usage & PROPERTY_USAGE_EDITOR):
			continue
		var pname := str(p.get("name", ""))
		if pname.is_empty() or pname.begins_with("_"):
			continue
		out[pname] = to_json(n.get(pname))
	return out


static func property_type(n: Object, pname: String) -> int:
	for p in n.get_property_list():
		if str(p.get("name", "")) == pname:
			return int(p.get("type", TYPE_NIL))
	return TYPE_NIL
