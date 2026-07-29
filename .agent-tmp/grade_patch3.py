import sys

with open(r'G:\japanesePractice\server\server.js', 'rb') as f:
    raw = f.read()
content = raw.decode('utf-8')

# Find the end of buildSummaryGradePrompt - right before buildTtsTextPrompt
INSERT_AFTER = '- Output valid JSON only. No markdown. No commentary outside JSON.`;\r\n}\r\nfunction buildTtsTextPrompt'
INSERT_MARKER = '}\r\nfunction buildTtsTextPrompt'

idx = content.find(INSERT_AFTER)
if idx == -1:
    # Try alternative
    idx = content.find('- Output valid JSON only. No markdown. No commentary outside JSON.`;\r\n}\r\nfunction buildTtsTextPrompt')
    print('Alternative search:', idx)

if idx == -1:
    print('ERROR: Insert point not found')
    # Show context
    tts_idx = content.find('function buildTtsTextPrompt')
    print(f'buildTtsTextPrompt at: {tts_idx}')
    print(repr(content[tts_idx-200:tts_idx]))
    sys.exit(1)
else:
    # Insert after the closing "}" of buildSummaryGradePrompt
    insert_at = content.find('\r\nfunction buildTtsTextPrompt', idx)
    print(f'Insert at: {insert_at}')
    print('Context:', repr(content[insert_at-50:insert_at+50]))