import bpy, sys, numpy as np, mathutils
args=sys.argv[sys.argv.index('--')+1:]
fbx,out,ratio,factor=args[0],args[1],float(args[2]),float(args[3])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
o=[x for x in bpy.data.objects if x.type=='MESH'][0]
bpy.context.view_layer.objects.active=o; o.select_set(True)
bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
m=o.data
co=np.empty(len(m.vertices)*3); m.vertices.foreach_get('co',co); co=co.reshape(-1,3)
# face region: front (y<0), centered ellipse around face center (x=0,z=0.0)
x,y,z=co[:,0],co[:,1],co[:,2]
d=np.sqrt((x/0.36)**2+((z-0.02)/0.50)**2)
w=np.clip((1.15-d)/0.3,0,1)*np.clip((-y-0.05)/0.15,0,1)
vg=o.vertex_groups.new(name='face')
for i in np.nonzero(w>0)[0]: vg.add([int(i)],float(w[i]),'REPLACE')
pre=o.modifiers.new('pre','DECIMATE'); pre.ratio=float(args[4]); pre.use_collapse_triangulate=True
bpy.ops.object.modifier_apply(modifier='pre')
mod=o.modifiers.new('dec','DECIMATE'); mod.ratio=ratio; mod.vertex_group='face'; mod.vertex_group_factor=factor; mod.use_collapse_triangulate=True; mod.invert_vertex_group=True
bpy.ops.object.modifier_apply(modifier='dec')
print('RESULT verts',len(m.vertices),'tris',len(m.polygons))
co=np.empty(len(m.vertices)*3); m.vertices.foreach_get('co',co); co=co.reshape(-1,3)
x,y,z=co[:,0],co[:,1],co[:,2]; d=np.sqrt((x/0.36)**2+((z-0.02)/0.50)**2)
print('RESULT face verts',int(((d<1.0)&(y<-0.05)).sum()))
for p in m.polygons: p.use_smooth=True
bpy.ops.export_scene.gltf(filepath=out,export_format='GLB',export_materials='PLACEHOLDER',export_yup=True,export_apply=True)
