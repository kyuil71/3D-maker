import bpy, sys, math, mathutils
fbx, tex, out = sys.argv[sys.argv.index('--')+1:][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
o=[x for x in bpy.data.objects if x.type=='MESH'][0]
mat=o.data.materials[0]; mat.use_nodes=True
nt=mat.node_tree; bsdf=[n for n in nt.nodes if n.type=='BSDF_PRINCIPLED'][0]
img=bpy.data.images.load(tex); t=nt.nodes.new('ShaderNodeTexImage'); t.image=img
nt.links.new(t.outputs[0], bsdf.inputs['Base Color'])
sc=bpy.context.scene; sc.render.engine='BLENDER_WORKBENCH'
sc.display.shading.light='FLAT'; sc.display.shading.color_type='TEXTURE'
sc.render.resolution_x=sc.render.resolution_y=900
cam=bpy.data.objects.new('cam',bpy.data.cameras.new('c')); sc.collection.objects.link(cam); sc.camera=cam
cam.data.type='ORTHO'
views=dict(front=(0,-5,0),side=(5,0,0),back=(0,5,0))
for name,(x,y,z) in views.items():
    cam.data.ortho_scale=2.0
    cam.location=(x,y,z); d=mathutils.Vector((0,0,0))-cam.location
    cam.rotation_euler=d.to_track_quat('-Z','Y').to_euler()
    sc.render.filepath=f'{out}_{name}.png'; bpy.ops.render.render(write_still=True)
