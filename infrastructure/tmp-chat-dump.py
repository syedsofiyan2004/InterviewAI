import json, datetime, os
path = os.path.join(os.environ.get('TEMP', '.'), 'chat-scan.json')
data = json.load(open(path, encoding='utf-8', errors='replace'))
items = data.get('Items', [])
items.sort(key=lambda i: int(i.get('created_at', {}).get('N', '0')), reverse=True)
out = []
for item in items[:16]:
    role = item.get('role', {}).get('S', '?')
    ts = int(item.get('created_at', {}).get('N', '0'))
    content = item.get('content', {}).get('S', '')
    t = datetime.datetime.fromtimestamp(ts / 1000).strftime('%d-%m %H:%M')
    thread = item.get('thread_id', {}).get('S', '?')[:44]
    out.append(f'=== [{role}] {t} {thread}')
    out.append(content[:1000])
    out.append('')
open('tmp-chat-out.txt', 'w', encoding='utf-8', errors='replace').write('\n'.join(out))
