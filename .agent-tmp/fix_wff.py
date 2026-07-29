with open(r'G:\japanesePractice\server\test-playwright-grade.js', 'rb') as f:
    raw = f.read()
content = raw.decode('utf-8')

# In playwright, waitForFunction(fn, arg, options) - need null as 2nd arg
# Fix all 4 waitForFunction calls by adding null arg
replacements = [
    (
        "await page.waitForFunction(\r\n      () => document.getElementById('home-screen')?.classList.contains('active'),\r\n      { timeout:20000 }\r\n    );",
        "await page.waitForFunction(\r\n      () => document.getElementById('home-screen')?.classList.contains('active'),\r\n      null,\r\n      { timeout:20000 }\r\n    );"
    ),
    (
        "await page.waitForFunction(\r\n      () => document.getElementById('test-screen')?.classList.contains('active'),\r\n      { timeout: TIMEOUT_START }\r\n    );",
        "await page.waitForFunction(\r\n      () => document.getElementById('test-screen')?.classList.contains('active'),\r\n      null,\r\n      { timeout: TIMEOUT_START }\r\n    );"
    ),
    (
        "await page.waitForFunction(\r\n      () => document.getElementById('loading-screen')?.classList.contains('active'),\r\n      { timeout:10000 }\r\n    ).catch(() => log('(no loading screen transition)'));",
        "await page.waitForFunction(\r\n      () => document.getElementById('loading-screen')?.classList.contains('active'),\r\n      null,\r\n      { timeout:10000 }\r\n    ).catch(() => log('(no loading screen transition)'));"
    ),
    (
        "await page.waitForFunction(\r\n      () => document.getElementById('review-screen')?.classList.contains('active'),\r\n      { timeout: TIMEOUT_GRADE }\r\n    );",
        "await page.waitForFunction(\r\n      () => document.getElementById('review-screen')?.classList.contains('active'),\r\n      null,\r\n      { timeout: TIMEOUT_GRADE }\r\n    );"
    ),
]

for old, new in replacements:
    if old in content:
        content = content.replace(old, new, 1)
        print(f'Fixed: {old[:60]!r}...')
    else:
        print(f'NOT FOUND: {old[:60]!r}...')

with open(r'G:\japanesePractice\server\test-playwright-grade.js', 'wb') as f:
    f.write(content.encode('utf-8'))
print('Saved')
