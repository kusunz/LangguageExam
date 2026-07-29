with open(r'G:\japanesePractice\server\test-playwright-grade.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Simply replace all waitForFunction calls to add null arg
# Pattern: waitForFunction(\n  ...,\n  { timeout: X }\n  )
import re

# Replace waitForFunction(fn, {timeout}) -> waitForFunction(fn, null, {timeout})
def add_null_arg(m):
    return m.group(0).replace(
        '\n      { timeout',
        '\n      null,\n      { timeout'
    )

pattern = r'await page\.waitForFunction\(\s*\(\) => [^\n]+,\s*\{ timeout[^}]+\}\s*\)'
new_content = re.sub(pattern, add_null_arg, content, flags=re.DOTALL)

count = new_content.count('null,\n      { timeout')
print(f'Fixed {count} occurrences')

with open(r'G:\japanesePractice\server\test-playwright-grade.js', 'w', encoding='utf-8', newline='') as f:
    f.write(new_content)
print('Saved')
