import json
# 1k front-render pixel coords; character RIGHT = image left (X<0)
R=dict(
 eyeUpper=[(242.5,315),(265,297.5),(310,281),(355,287),(390,307.5),(412.5,327.5)],
 eyeLower=[(242.5,315),(270,330),(320,342.5),(380,337.5),(412.5,327.5)],
 iris=(331.9,303.5), brow=[(405,172),(350,150),(300,140),(245,145),(200,165)],
 mouthCorner=(360,735), noseAla=(455,575), cheek=(280,520), jawAngle=(170,760),
)
def mir(p): return (1022-p[0],p[1]+2)
L={k:([mir(p) for p in v] if isinstance(v,list) else mir(v)) for k,v in R.items()}
L['mouthCorner']=(662,736); L['iris']=(690.3,304.5)
C=dict(lipLine=[(360,735),(400,737),(440,729),(511,727),(580,730),(620,736),(662,736)],
 upperLipTop=(511,668), lowerLipBottom=(511,802), noseTip=(511,520), noseBridge=(511,330),
 chin=(511,925), forehead=(511,80), philtrum=(511,640), chinCrease=(511,850))
def tx(p): return [round((p[0]-512)/1024,5), round((562-p[1])/1024,5)]
out={'R':{k:([tx(p) for p in v] if isinstance(v,list) else tx(v)) for k,v in R.items()},
     'L':{k:([tx(p) for p in v] if isinstance(v,list) else tx(v)) for k,v in L.items()},
     'C':{k:([tx(p) for p in v] if isinstance(v,list) else tx(v)) for k,v in C.items()},
     'irisRadius':0.037,'tmj':{'y':0.11,'z':0.03}}
json.dump(out,open('/home/claude/src/build/landmarks.json','w'),indent=1)
from PIL import Image, ImageDraw
im=Image.open('face1k.png'); d=ImageDraw.Draw(im)
for S in (R,L,C):
  for k,v in S.items():
    pts=v if isinstance(v,list) else [v]
    if len(pts)>1: d.line(pts,fill=(0,255,0),width=1)
    for p in pts: d.ellipse([p[0]-3,p[1]-3,p[0]+3,p[1]+3],outline=(255,0,0))
for c in (R['iris'],L['iris']): d.ellipse([c[0]-39,c[1]-39,c[0]+39,c[1]+39],outline=(0,200,255))
im.save('lm_overlay.png'); im.crop((200,250,830,380)).resize((1260,260)).save('lm_eyes.png')
