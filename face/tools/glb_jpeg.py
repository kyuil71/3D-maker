import json, struct, sys, io
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
b = open(src,'rb').read()
jl = struct.unpack_from('<I', b, 12)[0]; J = json.loads(b[20:20+jl])
bo = 20+jl; bl = struct.unpack_from('<I', b, bo)[0]; BIN = b[bo+8:bo+8+bl]
slot = {}
for m in J.get('materials',[]):
    pbr = m.get('pbrMetallicRoughness',{})
    if 'baseColorTexture' in pbr: slot[J['textures'][pbr['baseColorTexture']['index']]['source']] = 'color'
    if 'normalTexture' in m: slot[J['textures'][m['normalTexture']['index']]['source']] = 'normal'
repl = {}
for i, img in enumerate(J.get('images',[])):
    bv = J['bufferViews'][img['bufferView']]; data = BIN[bv.get('byteOffset',0): bv.get('byteOffset',0)+bv['byteLength']]
    s = slot.get(i)
    if s in ('color','normal'):
        im = Image.open(io.BytesIO(data)).convert('RGB'); out = io.BytesIO(); im.save(out, 'JPEG', quality=92 if s=='color' else 95, subsampling=0 if s=='normal' else 2)
        repl[img['bufferView']] = out.getvalue(); img['mimeType'] = 'image/jpeg'
        print(i, s, len(data)//1024, '->', len(out.getvalue())//1024, 'KB')
nb = bytearray()
for k, bv in enumerate(J['bufferViews']):
    data = repl.get(k, BIN[bv.get('byteOffset',0): bv.get('byteOffset',0)+bv['byteLength']])
    while len(nb) % 4: nb.append(0)
    bv['byteOffset'] = len(nb); bv['byteLength'] = len(data); nb += data
while len(nb) % 4: nb.append(0)
J['buffers'][0]['byteLength'] = len(nb)
J.setdefault('asset',{})['generator'] = 'Serene Facial Animation Studio (three.js GLTFExporter + glTF-Transform sparse)'
js = json.dumps(J, separators=(',',':')).encode()
while len(js) % 4: js += b' '
out = struct.pack('<III', 0x46546C67, 2, 12+8+len(js)+8+len(nb)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(nb), 0x004E4942) + nb
open(dst,'wb').write(out); print('written', len(out)//1024, 'KB')
