#!/usr/bin/env python3
"""
Syntax checks for the Godot and Unity adapters (no editor or compiler needed).

    python3 -m venv .lint && .lint/bin/pip install "gdtoolkit==4.*" "tree_sitter==0.25.2" "tree_sitter_c_sharp==0.23.1" "tree_sitter_hlsl==0.2.0"
    .lint/bin/python scripts/lint-adapters.py

GDScript files are parsed with gdtoolkit's Godot 4 grammar (`gdparse`) and linted with
`gdlint`'s error-class rules. C# files are parsed with tree-sitter's C# grammar and must
contain no ERROR / MISSING nodes. This proves the files are syntactically valid; it does
not type-check them against the Godot or Unity APIs (that needs the engines themselves).
"""
import os
import re
import shutil
import tempfile
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
bin_dir = pathlib.Path(sys.executable).parent
failures = 0

gd_files = sorted((root / "adapters" / "godot").glob("*.gd"))
for path in gd_files:
    result = subprocess.run([str(bin_dir / "gdparse"), str(path)], capture_output=True, text=True)
    if result.returncode != 0:
        failures += 1
        print(f"FAIL gdparse {path.relative_to(root)}\n{(result.stdout + result.stderr).strip()[:600]}")
    else:
        print(f"ok   gdparse {path.relative_to(root)}")

# Style / correctness lint with the adapters' own configuration.
config = root / "adapters" / "godot" / "gdlintrc"
lint = subprocess.run([str(bin_dir / "gdlint"), *map(str, gd_files)], capture_output=True, text=True, cwd=config.parent)

if lint.returncode != 0:
    failures += 1
    print("FAIL gdlint\n" + (lint.stdout + lint.stderr).strip()[:1500])
else:
    print(f"ok   gdlint  {len(gd_files)} files")

try:
    import tree_sitter_c_sharp
    from tree_sitter import Language, Parser

    parser = Parser(Language(tree_sitter_c_sharp.language()))

    def problems(node, out):
        if node.type == "ERROR" or node.is_missing:
            out.append((node.start_point[0] + 1, node.start_point[1] + 1, node.type))
        for child in node.children:
            problems(child, out)

    for path in sorted((root / "adapters" / "unity").glob("*.cs")):
        tree = parser.parse(path.read_bytes())
        found = []
        problems(tree.root_node, found)
        if found:
            failures += 1
            print(f"FAIL csharp  {path.relative_to(root)}: " + ", ".join(f"{line}:{col} {kind}" for line, col, kind in found[:6]))
        else:
            print(f"ok   csharp  {path.relative_to(root)}")
except ImportError:
    print("skip csharp  (pip install tree_sitter==0.25.2 tree_sitter_c_sharp==0.23.1)")

# A headless project asks the Godot 4 shader compiler to parse each resource.
godot = os.environ.get("GODOT_BIN") or shutil.which("godot4") or shutil.which("godot")
if godot:
    with tempfile.TemporaryDirectory(prefix="lumina-gdshader-") as temp:
        project = pathlib.Path(temp)
        (project / "project.godot").write_text('[application]\nconfig/name="Shader check"\n')
        files = list((root / "adapters/godot").glob("*.gdshader"))
        for shader in files:
            shutil.copy2(shader, project / shader.name)
        for script in ("lumina_world_bus.gd", "lumina_cloth.gd", "lumina_wet_road.gd"):
            shutil.copy2(root / "adapters/godot" / script, project)
        # Sample both the numerical field and its lifetime in the actual Godot runtime.
        bus_probe = """    var bus = preload("res://lumina_world_bus.gd").new()
    bus.set_source(5, Vector3(-4,2,0), Vector3(4,2,0), 2.0, Vector4(4,2,0,0), Vector4(2,100,0.7,0.9), 1.0)
    var sample_point = Vector3(0,2,1)
    var fields = bus.fields_at(sample_point)
    var air = bus.wind_at(sample_point)
    var ok = fields.is_equal_approx(Vector4(1.125,74.25,0.39375,0.50625)) and air.is_equal_approx(Vector3(-1.125,0,2.25))
    bus._physics_process(1.05)
    ok = ok and bus.fields_at(sample_point).is_equal_approx(Vector4(0,18,0,0)) and bus.wind_at(sample_point).is_zero_approx()
    bus.set_source(0, Vector3(-10,5,0), Vector3(10,5,0), 4.0, Vector4(0,8,0,0), Vector4.ZERO, 1.0, true)
    ok = ok and bus.wind_at(Vector3(0,5,2)).is_equal_approx(Vector3(0,4.5,0))
    bus.set_rotor(0, Vector3(0,4,0), 6.0, 1.0, 0.0, true)
    ok = ok and bus.wind_at(Vector3(0,2,0)).y < 0.0 and bus.fields_at(Vector3.ZERO).z > 0.0
    ok = ok and bus.pressure_force_at(Vector3(2,1,0)).x > 0.0
    bus.set_vortex(0, Vector3.ZERO, Vector3(0,20,0), 8.0, 1.0, false)
    ok = ok and bus.wind_at(Vector3(3,2,0)).y > 0.0 and bus.wind_at(Vector3(3,2,0)).z > 0.0
    var cloth = preload("res://lumina_cloth.gd").new()
    root.add_child(bus)
    bus.add_child(cloth)
    ok = ok and cloth.world_fields == bus and cloth._wind_at(Vector3(3,2,0)).is_equal_approx(bus.wind_at(Vector3(3,2,0)))
    var road = preload("res://lumina_wet_road.gd").new()
    road.mesh = PlaneMesh.new()
    var road_material = ShaderMaterial.new()
    road_material.shader = load("res://lumina_wet_road.gdshader")
    road.material_override = road_material
    root.add_child(road)
    road.flood = 0.0
    var sole = Vector3(-3.2, 0.0, 85.0)
    sole.y = road.surface_height(sole.x, sole.z)
    road.disturb_puddle(sole, 0.1, 1.5)
    ok = ok and is_zero_approx(road.puddle_depth(sole.x, sole.z)) and road._count == 0
    road.flood = 0.94
    road.disturb_puddle(sole + Vector3.UP, 0.1, 1.5)
    ok = ok and road._count == 0
    for i in 25:
        road.disturb_puddle(sole, 0.1, 1.5)
    road._process(0.2)
    var active_mat = road.get_active_material(0)
    var packets = active_mat.get_shader_parameter("wave_events")
    ok = ok and active_mat != road_material and int(active_mat.get_shader_parameter("wave_count")) == 24
    ok = ok and int(active_mat.get_shader_parameter("wave_first")) == 1 and packets[1].w > 0.0
    road._process(2.0)
    ok = ok and int(active_mat.get_shader_parameter("wave_count")) == 0
    road.free()
    bus.free()
    if not ok:
        push_error("World field runtime parity")
        quit(1)
        return
"""
        (project / "check.gd").write_text(
            'extends SceneTree\nfunc _initialize():\n    call_deferred("check")\nfunc check():\n'
            + "".join(f'    if load("res://{f.name}").get_shader_uniform_list().is_empty():\n        quit(1)\n        return\n' for f in files)
            + bus_probe + "    quit()\n"
        )
        run = subprocess.run([godot, "--headless", "--path", temp, "--script", "check.gd"], capture_output=True, text=True)
        valid = run.returncode == 0 and "SHADER ERROR" not in run.stderr and "SCRIPT ERROR" not in run.stderr
        print(f"{'ok  ' if valid else 'FAIL'} gdshader {len(files)} Godot shader resources, runtime fields and wet-road packets")
        if not valid:
            print((run.stdout + run.stderr)[-2000:])
            failures += 1
else:
    print("skip gdshader (set GODOT_BIN to a Godot 4 executable)")

try:
    import tree_sitter_hlsl
    from tree_sitter import Language, Parser
    hlsl = Parser(Language(tree_sitter_hlsl.language()))
    for shader in sorted((root / "adapters/unity").glob("*.shader")):
        blocks = re.findall(r"\bHLSLPROGRAM\b(.*?)\bENDHLSL\b", shader.read_text(), re.S)
        valid = bool(blocks) and all(not hlsl.parse(block.encode()).root_node.has_error for block in blocks)
        print(f"{'ok  ' if valid else 'FAIL'} hlsl    {shader.relative_to(root)}")
        failures += int(not valid)
    for include in sorted((root / "adapters/unity").glob("*.hlsl")):
        valid = not hlsl.parse(include.read_bytes()).root_node.has_error
        print(f"{'ok  ' if valid else 'FAIL'} hlsl    {include.relative_to(root)}")
        failures += int(not valid)
except ImportError:
    print("skip hlsl    (install tree_sitter_hlsl for Unity shader syntax checks)")

print(f"\n{len(gd_files)} GDScript file(s) checked, {failures} failure(s)")
sys.exit(1 if failures else 0)
