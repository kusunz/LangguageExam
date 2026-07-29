import sys

with open(r'G:\japanesePractice\server\server.js', 'rb') as f:
    raw = f.read()
content = raw.decode('utf-8')

# =============================================================
# FIX 2: summaryValidator in runSplitGrading
# Bug: checks s.strong_tags but prompt outputs "strength_tags"
# Fix: check s.strength_tags (match the prompt schema)
# =============================================================
old2 = (
    '      if (!Array.isArray(s.strong_tags)) errors.push("invalid_strong_tags");\r\n'
)
new2 = (
    '      if (!Array.isArray(s.strength_tags) && !Array.isArray(s.strong_tags)) errors.push("invalid_strong_tags");\r\n'
)
if old2 in content:
    content = content.replace(old2, new2, 1)
    print('FIX 2 (strong_tags validator): applied')
else:
    print('FIX 2: NOT FOUND, trying LF version')
    old2b = '      if (!Array.isArray(s.strong_tags)) errors.push("invalid_strong_tags");\n'
    new2b = '      if (!Array.isArray(s.strength_tags) && !Array.isArray(s.strong_tags)) errors.push("invalid_strong_tags");\n'
    if old2b in content:
        content = content.replace(old2b, new2b, 1)
        print('FIX 2 (LF): applied')
    else:
        print('FIX 2: still NOT FOUND')

# Also fix the prompt schema: add "strong_tags" alias so LLM can use either name
# The prompt already says "strength_tags" which is fine - just fix validator
# Additionally fix the reader side: when consuming analysis.summary, also check strong_tags
# (already done by: ...ensureObject(analysis.summary) which spreads both)

# =============================================================
# FIX 3: getExamInstanceAccess - demo users should skip attempt check
# Bug: demo user attempts row may not exist (cleaned up) -> returns attemptStatus=null
# That's actually OK (null != 'active' != other statuses)
# Real bug: getExamInstanceAccess queries DB but demo users' instances may have been
# deleted by cleanupExpiredDemoArtifacts. Add a demo-user bypass.
# =============================================================
old3 = (
    'async function getExamInstanceAccess(userId, instanceKey) {\r\n'
    '  const inst = await db.query(\r\n'
    "    'SELECT user_id FROM exam_instances_cache WHERE instance_key=$1',\r\n"
    '    [instanceKey]\r\n'
    '  );\r\n'
    '\r\n'
    '  if (inst.rows.length === 0) {\r\n'
    "    return { ok: false, status: 404, error: 'Instance not found' };\r\n"
    '  }\r\n'
    '\r\n'
    '  if (inst.rows[0].user_id !== userId) {\r\n'
    "    return { ok: false, status: 404, error: 'Instance not found' };\r\n"
    '  }\r\n'
    '\r\n'
    '  const attempt = await db.query(\r\n'
    '    `SELECT status\r\n'
    '     FROM attempts\r\n'
    '     WHERE user_id=$1 AND instance_key=$2\r\n'
    '     ORDER BY started_at DESC\r\n'
    '     LIMIT 1`,\r\n'
    '    [userId, instanceKey]\r\n'
    '  );\r\n'
    '\r\n'
    '  return {\r\n'
    '    ok: true,\r\n'
    "    attemptStatus: attempt.rows[0]?.status || null\r\n"
    '  };\r\n'
    '}'
)
new3 = (
    'async function getExamInstanceAccess(userId, instanceKey) {\r\n'
    '  const inst = await db.query(\r\n'
    "    'SELECT user_id FROM exam_instances_cache WHERE instance_key=$1',\r\n"
    '    [instanceKey]\r\n'
    '  );\r\n'
    '\r\n'
    '  if (inst.rows.length === 0) {\r\n'
    "    return { ok: false, status: 404, error: 'Instance not found' };\r\n"
    '  }\r\n'
    '\r\n'
    '  if (inst.rows[0].user_id !== userId) {\r\n'
    "    return { ok: false, status: 404, error: 'Instance not found' };\r\n"
    '  }\r\n'
    '\r\n'
    '  // Demo users: skip attempt-status check (attempts may have been cleaned up)\r\n'
    '  if (isDemoUserId(userId)) {\r\n'
    "    return { ok: true, attemptStatus: 'active' };\r\n"
    '  }\r\n'
    '\r\n'
    '  const attempt = await db.query(\r\n'
    '    `SELECT status\r\n'
    '     FROM attempts\r\n'
    '     WHERE user_id=$1 AND instance_key=$2\r\n'
    '     ORDER BY started_at DESC\r\n'
    '     LIMIT 1`,\r\n'
    '    [userId, instanceKey]\r\n'
    '  );\r\n'
    '\r\n'
    '  return {\r\n'
    '    ok: true,\r\n'
    "    attemptStatus: attempt.rows[0]?.status || null\r\n"
    '  };\r\n'
    '}'
)
if old3 in content:
    content = content.replace(old3, new3, 1)
    print('FIX 3 (demo getExamInstanceAccess): applied')
else:
    print('FIX 3: NOT FOUND')

with open(r'G:\japanesePractice\server\server.js', 'wb') as f:
    f.write(content.encode('utf-8'))
print('server.js saved')
