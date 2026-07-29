import sys

with open(r'G:\japanesePractice\server\providers\llm-router.js', 'rb') as f:
    raw = f.read()
content = raw.decode('utf-8')

# FIX 1: Repair primary model - nano is too weak for explain-task repairs.
# Use super-120b as the default repair model (same as explain secondary).
old1 = (
    '    repair: {\r\n'
    '      openrouterPrimary: process.env.OPENROUTER_MODEL_REPAIR_PRIMARY || "nvidia/nemotron-3-nano-30b-a3b:free",\r\n'
    '      openrouterSecondary: process.env.OPENROUTER_MODEL_REPAIR_SECONDARY || "openrouter/free"\r\n'
    '    },'
)
new1 = (
    '    repair: {\r\n'
    '      openrouterPrimary: process.env.OPENROUTER_MODEL_REPAIR_PRIMARY || "nvidia/nemotron-3-super-120b-a12b:free",\r\n'
    '      openrouterSecondary: process.env.OPENROUTER_MODEL_REPAIR_SECONDARY || "nvidia/nemotron-3-nano-30b-a3b:free"\r\n'
    '    },'
)
if old1 in content:
    content = content.replace(old1, new1, 1)
    print('FIX 1 (repair model): applied')
else:
    print('FIX 1: NOT FOUND')

with open(r'G:\japanesePractice\server\providers\llm-router.js', 'wb') as f:
    f.write(content.encode('utf-8'))
print('llm-router.js saved')
