// Lua 5.1 for the game's scripts (wasmoon-lua5.1: the real Lua 5.1 VM in
// WebAssembly). Boots Scripts/main.lua from the asset VFS and runs behaviour-tree
// Lua (ExecuteLua / LuaWrapper code) with `entity` (the NPC) and `data` (the
// tree's variables, copied in and written back when changed).
//
// The engine's script API (System, XGenAIModule, Contexts, entity.soul, …) is not
// implemented yet: any capitalised global the scripts touch is a logging stub, a
// table that answers missing keys with nested stubs and can be called (returns
// nil). `calls` counts what was called, to decide what to implement first.

import { Lua } from "wasmoon-lua5.1";
import type { Vfs } from "./vfs.ts";
import type { Value } from "./btRuntime.ts";
import { parseXml, type XmlNode } from "./xml.ts";

/**
 * CryAction.LoadXML(definition, data): CryEngine's schema-driven XML → Lua loader. The definition
 * (<Definition root=…>) maps <Property name= type=> to attributes and <Array name= elementName=> to a
 * child element whose elementName children form a list (recursively; typed arrays hold values).
 */
/** A database table as the Database script API sees it: typed columns in header order, rows of values. */
interface DbTable {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
}

function parseDbTable(xml: string): DbTable {
  const columns = [...xml.matchAll(/<column\s+name="([^"]+)"\s+type="([^"]*)"/g)].map((m) => ({ name: m[1], type: m[2] }));
  const un = (v: string) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const conv = (type: string, v: string | undefined): string | number | boolean | null => {
    if (v === undefined || v === "") return null;
    if (/int|real|double|float|numeric/.test(type)) return Number(v);
    if (type === "boolean") return /^(true|t|1)$/i.test(v);
    return un(v);
  };
  const rows: DbTable["rows"] = [];
  for (const m of xml.matchAll(/<row\s([^>]*?)\/>/g)) {
    const attrs = new Map([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    rows.push(columns.map((c) => conv(c.type, attrs.get(c.name))));
  }
  return { columns, rows };
}

export function loadLuaXml(defXml: string, dataXml: string): unknown {
  const def = parseXml(defXml).children.find((c) => c.tag === "Definition");
  const data = parseXml(dataXml).children[0];
  if (!def || !data) return null;
  const scalar = (type: string | undefined, v: string | undefined) =>
    v === undefined ? undefined : type === "int" || type === "float" ? Number(v) : type === "bool" ? v === "true" || v === "1" : v;
  const convert = (spec: XmlNode, node: XmlNode): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const p of spec.children) {
      const name = p.attrs.name;
      if (!name) continue;
      if (p.tag === "Property") {
        const v = scalar(p.attrs.type, node.attrs[name]);
        if (v !== undefined) out[name] = v;
      } else if (p.tag === "Array") {
        const holder = node.children.find((c) => c.tag === name);
        const items = (holder?.children ?? []).filter((c) => !p.attrs.elementName || c.tag === p.attrs.elementName);
        out[name] = p.attrs.type ? items.map((c) => scalar(p.attrs.type, c.attrs.value ?? c.text)) : items.map((c) => convert(p, c));
      } else if (p.tag === "Table") {
        const child = node.children.find((c) => c.tag === name);
        if (child) out[name] = convert(p, child);
      }
    }
    return out;
  };
  return convert(def, data);
}

const PRELUDE = `
local stubs = {}
local function mkstub(path)
  local s = stubs[path]
  if s then return s end
  s = setmetatable({}, {
    __index = function(t, k)
      -- engine API is PascalCase functions/tables; lower-case keys are data the engine doesn't have
      if type(k) ~= "string" or not k:match("^%u") then return nil end
      local c = mkstub(path .. "." .. k)
      rawset(t, k, c)
      return c
    end,
    __call = function(self, ...) __kcd_call(path) return nil end,
  })
  stubs[path] = s
  return s
end
__kcd_stub = mkstub
-- engine enums missing from TypeDefinitions.xml: enum_x.y = "x.y"
local function autoenum(name)
  return setmetatable({}, { __index = function(t, k) local v = name .. "." .. tostring(k) rawset(t, k, v) return v end })
end
-- capitalised globals the scripts expect from the engine become stubs
setmetatable(_G, { __index = function(t, k)
  if type(k) == "string" and k:match("^enum_") then
    local e = autoenum(k:sub(6))
    rawset(t, k, e)
    return e
  end
  if type(k) == "string" and k:match("^%u") then
    local s = mkstub(k)
    rawset(t, k, s)
    return s
  end
end })

-- Script.ReloadScript / LoadScript: run another script from the game's files
function __kcd_reload(path)
  local src = __kcd_read(path)
  if not src then __kcd_error("missing script " .. tostring(path)) return false end
  local f, err = loadstring(src, "@" .. path)
  if not f then __kcd_error(err) return false end
  local ok, e = pcall(f)
  if not ok then __kcd_error(tostring(e)) end
  return ok
end
Script = mkstub("Script")
rawset(Script, "ReloadScript", function(p) return __kcd_reload(p) end)
rawset(Script, "LoadScript", function(p) return __kcd_reload(p) end)
rawset(Script, "UnloadScript", function() end)
System = mkstub("System")
CryAction = mkstub("CryAction")
rawset(CryAction, "LoadXML", function(def, data)
  local j = __kcd_loadxml(def, data)
  if not j then __kcd_error("LoadXML: missing " .. tostring(def) .. " / " .. tostring(data)) return nil end
  return __kcd_decode(j)
end)
-- the Database script API over the game's tables (Libs/Tables, preloaded): indices are 0-based
Database = mkstub("Database")
rawset(Database, "GetTableInfo", function(t) return __kcd_decode(__kcd_db("info", t) or "null") end)
rawset(Database, "GetColumnInfo", function(t, c) return __kcd_decode(__kcd_db("column", t, c) or "null") end)
rawset(Database, "GetTableColumnData", function(t, c) return __kcd_decode(__kcd_db("data", t, c) or "null") end)
rawset(Database, "GetTableLine", function(t, n) return __kcd_decode(__kcd_db("line", t, n) or "null") end)
-- brain variables: a per-entity store of tables the scripts modify in place
XGenAIModule = mkstub("XGenAIModule")
-- WUIDs are entity ids here
rawset(XGenAIModule, "GetEntityByWUID", function(wuid) if wuid == nil then return nil end return __kcd_entity(wuid) end)
rawset(XGenAIModule, "GetEntityIdByWUID", function(wuid) return wuid end)
rawset(XGenAIModule, "GetMyWUID", function(entity) return entity and entity.id end)
TError = function(...) local parts = {} for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end __kcd_error("TError: " .. table.concat(parts, " ")) end
local brains = {}
rawset(XGenAIModule, "GetBrainVariable", function(id, name)
  local b = brains[id] or {}
  brains[id] = b
  if b[name] == nil then b[name] = {} end
  return b[name]
end)
rawset(XGenAIModule, "SetBrainVariable", function(id, name, value)
  local b = brains[id] or {}
  brains[id] = b
  b[name] = value
end)
for _, n in ipairs({ "Log", "LogAlways", "LogWarning", "Warning", "Error" }) do
  rawset(System, n, function(msg) __kcd_log(n, tostring(msg)) end)
end

-- JSON for reading values back (tables → arrays/objects; stubs and functions dropped)
local function esc(s)
  return '"' .. s:gsub('[%c"\\\\]', function(c) return string.format("\\\\u%04x", c:byte()) end) .. '"'
end
local function json(v, depth)
  local t = type(v)
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.17g", v)
  elseif t == "string" then return esc(v)
  elseif t == "boolean" then return tostring(v)
  elseif t == "table" then
    -- stubs and engine objects carry metatables: not data
    if depth > 8 or getmetatable(v) then return "null" end
    local n = #v
    local count = 0
    for _ in pairs(v) do count = count + 1 end
    local parts = {}
    if n > 0 and count == n then
      for i = 1, n do parts[i] = json(v[i], depth + 1) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, x in pairs(v) do
      if type(k) == "string" or type(k) == "number" then
        local tx = type(x)
        if tx ~= "function" and tx ~= "userdata" and tx ~= "thread" then
          parts[#parts + 1] = esc(tostring(k)) .. ":" .. json(x, depth + 1)
        end
      end
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end
__kcd_json = function(v) return json(v, 0) end

-- JSON → Lua (arrays become 1-based tables); no backslash escapes in this source
local BS, QUOTE = string.char(92), string.char(34)
local ESC = { n = string.char(10), t = string.char(9), r = string.char(13), b = string.char(8), f = string.char(12) }
local function decode(str)
  local pos = 1
  local function ws() pos = str:find("[^%s]", pos) or #str + 1 end
  local value
  local function str_()
    local out, i = {}, pos + 1
    while true do
      local c = str:sub(i, i)
      if c == QUOTE then pos = i + 1 return table.concat(out) end
      if c == BS then
        local e = str:sub(i + 1, i + 1)
        if e == "u" then
          local code = tonumber(str:sub(i + 2, i + 5), 16)
          out[#out + 1] = code < 256 and string.char(code) or "?"
          i = i + 6
        else
          out[#out + 1] = ESC[e] or e
          i = i + 2
        end
      else
        out[#out + 1] = c
        i = i + 1
      end
    end
  end
  value = function()
    ws()
    local c = str:sub(pos, pos)
    if c == "{" then
      local t = {}
      pos = pos + 1 ws()
      if str:sub(pos, pos) == "}" then pos = pos + 1 return t end
      while true do
        ws() local k = str_() ws() pos = pos + 1
        t[k] = value() ws()
        local d = str:sub(pos, pos) pos = pos + 1
        if d == "}" then return t end
      end
    elseif c == "[" then
      local t = {}
      pos = pos + 1 ws()
      if str:sub(pos, pos) == "]" then pos = pos + 1 return t end
      while true do
        t[#t + 1] = value() ws()
        local d = str:sub(pos, pos) pos = pos + 1
        if d == "]" then return t end
      end
    elseif c == QUOTE then return str_()
    elseif str:sub(pos, pos + 3) == "true" then pos = pos + 4 return true
    elseif str:sub(pos, pos + 4) == "false" then pos = pos + 5 return false
    elseif str:sub(pos, pos + 3) == "null" then pos = pos + 4 return nil
    else
      local num = str:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
      pos = pos + #num
      return tonumber(num)
    end
  end
  return value()
end
__kcd_decode = decode

-- run tree code with (entity, data); returns data as JSON
-- one Lua table per entity, as in the engine: scripts keep state on it (entity.contextsData, …).
-- Engine-provided parts (soul, human, actor, inventory, …) and methods (PascalCase) are stubs.
local ENGINE_PARTS = { soul = true, human = true, actor = true, inventory = true, horse = true, player = true, item = true, vehicle = true, physics = true, ai = true }
local entities = {}
function __kcd_entity(id, name)
  local e = entities[id]
  if e then return e end
  name = name or __kcd_entname(id)
  -- the soul keeps its meta roles (MERCHANT, REPAIRMAN, GOSSIP, …); other soul methods are stubs
  local roles = {}
  local soul = setmetatable({}, { __index = function(t, k)
    if type(k) ~= "string" or not k:match("^%u") then return nil end
    return mkstub("entity.soul." .. k)
  end })
  rawset(soul, "AddMetaRoleByName", function(self, role) roles[role] = true end)
  rawset(soul, "RemoveMetaRoleByName", function(self, role) roles[role] = nil end)
  rawset(soul, "HasMetaRoleByName", function(self, role) return roles[role] == true end)
  rawset(soul, "GetMetaRoles", function(self) local out = {} for r in pairs(roles) do out[#out + 1] = r end table.sort(out) return out end)
  e = setmetatable({ id = id, name = name, this = { id = id, name = name }, soul = soul }, { __index = function(t, k)
    if k == "Properties" then
      local p = __kcd_decode(__kcd_entprops(id) or "null") or {}
      rawset(t, k, p)
      return p
    end
    if type(k) == "string" and (ENGINE_PARTS[k] or k:match("^%u")) then
      local s = mkstub("entity." .. k)
      rawset(t, k, s)
      return s
    end
    return nil
  end })
  entities[id] = e
  return e
end

function __kcd_exec(code, entityId, entityName, dataJson)
  local entity = __kcd_entity(entityId, entityName)
  local data = decode(dataJson)
  local f, err = loadstring("local entity, data = ...\\n" .. code, "=tree")
  if not f then __kcd_error(err) return nil end
  local ok, e = pcall(f, entity, data)
  if not ok then __kcd_error(tostring(e)) elseif data.__kcd_result ~= nil then data.__kcd_result = (e ~= nil and e ~= false) end
  return json(data, 0)
end
`;

export class LuaHost {
  readonly lua: Lua;
  /** stubbed engine API calls by path (e.g. "entity.soul.AddMetaRoleByName") */
  readonly calls = new Map<string, number>();
  readonly errors: string[] = [];
  readonly logs: string[] = [];
  private vfs: Vfs;

  private constructor(lua: Lua, vfs: Vfs) {
    this.lua = lua;
    this.vfs = vfs;
  }

  /** `wasmUri`: where liblua5.1.wasm is served (never the CDN default). */
  static async create(vfs: Vfs, wasmUri: string): Promise<LuaHost> {
    const lua = await Lua.create({ customWasmUri: wasmUri } as never);
    const host = new LuaHost(lua, vfs);
    const g = lua.global;
    g.set("__kcd_call", (path: string) => { host.calls.set(path, (host.calls.get(path) ?? 0) + 1); });
    g.set("__kcd_error", (msg: string) => { if (host.errors.length < 500) host.errors.push(String(msg)); });
    g.set("__kcd_log", (kind: string, msg: string) => { if (host.logs.length < 500) host.logs.push(`${kind}: ${msg}`); });
    g.set("__kcd_read", (path: string) => host.readScript(path));
    g.set("__kcd_db", (what: string, table: string, i?: number) => host.db(what, table, i));
    g.set("__kcd_entname", (id: number) => host.entityName(Number(id)));
    g.set("__kcd_entprops", (id: number) => { const p = host.entityProps(Number(id)); return p ? JSON.stringify(p) : null; });
    g.set("__kcd_loadxml", (def: string, data: string) => {
      const d = host.readScript(def), x = host.readScript(data);
      return d && x ? JSON.stringify(loadLuaXml(d, x)) : null;
    });
    lua.doStringSync(PRELUDE);
    return host;
  }

  private readonly scripts = new Map<string, string>();

  /** Preload the game's Lua files (so ReloadScript can stay synchronous). */
  async preload(): Promise<number> {
    for (const p of this.vfs.paths()) {
      if (!p.endsWith(".lua") && !p.startsWith("libs/luaxml/")) continue;
      this.scripts.set(p, new TextDecoder("latin1").decode(await this.vfs.read(this.vfs.lookup(p)!)));
    }
    return this.scripts.size;
  }

  private tables = new Map<string, DbTable>();
  /** entity names by id (the level's entity index), for XGenAIModule.GetEntityByWUID */
  entityName: (id: number) => string = () => "";
  /** entity editor properties by id (entity.Properties) */
  entityProps: (id: number) => Record<string, unknown> | null = () => null;

  /** Database script API backend: JSON for GetTableInfo / GetColumnInfo / GetTableColumnData / GetTableLine. */
  private db(what: string, name: string, i?: number): string | null {
    const t = this.tables.get(String(name).toLowerCase());
    if (!t) {
      if (this.errors.length < 500) this.errors.push(`Database: table ${name} not loaded`);
      return null;
    }
    const k = Number(i ?? 0);
    switch (what) {
      case "info": return JSON.stringify({ LineCount: t.rows.length, ColumnCount: t.columns.length });
      case "column": return t.columns[k] ? JSON.stringify({ Name: t.columns[k].name, Type: t.columns[k].type }) : null;
      case "data": return t.columns[k] ? JSON.stringify(t.rows.map((r) => r[k])) : null;
      case "line": {
        const r = t.rows[k];
        return r ? JSON.stringify(Object.fromEntries(t.columns.map((c, j) => [c.name, r[j]]).filter(([, v]) => v !== null))) : null;
      }
    }
    return null;
  }

  /** Preload the database tables the scripts name in quotes (e.g. "soul", "new_homes_parcel"). */
  async preloadTables(): Promise<string[]> {
    const byName = new Map<string, string>();
    for (const p of this.vfs.paths()) if (p.startsWith("libs/tables/") && p.endsWith(".xml")) byName.set(p.slice(p.lastIndexOf("/") + 1, -4), p);
    const quoted = new Set<string>();
    for (const src of this.scripts.values()) for (const m of src.matchAll(/["']([a-z_0-9]+)["']/gi)) quoted.add(m[1].toLowerCase());
    const names = [...quoted].filter((n) => byName.has(n));
    for (const n of names) this.tables.set(n, parseDbTable(new TextDecoder().decode(await this.vfs.read(this.vfs.lookup(byName.get(n)!)!))));
    return names;
  }

  private readScript(path: string): string | undefined {
    return this.scripts.get(String(path).replaceAll("\\", "/").toLowerCase());
  }

  /** Define the engine's enum_<name> tables (from TypeDefs.luaEnums()). */
  defineEnums(src: string): void {
    this.lua.doStringSync(src);
  }

  /** The game's script start-up: run Scripts/main.lua, then its OnInit() (which loads the rest). */
  boot(): boolean {
    return this.lua.doStringSync(`
      if not __kcd_reload("scripts/main.lua") then return false end
      if type(OnInit) == "function" then
        local ok, e = pcall(OnInit)
        if not ok then __kcd_error("OnInit: " .. tostring(e)) return false end
      end
      return true`) === true;
  }

  /** Run tree code; returns the variables whose values changed. */
  run(code: string, data: Record<string, Value>, entity: { id: number; name: string }): Record<string, Value> {
    const before = JSON.stringify(data);
    this.lua.global.set("__kcd_data", before);
    this.lua.global.set("__kcd_code", code);
    const out = this.lua.doStringSync(`return __kcd_exec(__kcd_code, ${Number(entity.id)}, ${JSON.stringify(entity.name)}, __kcd_data)`) as string | null;
    if (!out) return {};
    const after = JSON.parse(out) as Record<string, Value>;
    const old = JSON.parse(before) as Record<string, Value>;
    const changed: Record<string, Value> = {};
    for (const [k, v] of Object.entries(after)) if (JSON.stringify(v) !== JSON.stringify(old[k])) changed[k] = v;
    return changed;
  }
}
