from pathlib import Path

path = Path("plugins/BetterChatCopy/src/index.tsx")
text = path.read_text(encoding="utf-8")

old = '''        .replace(/<a?:([^:]+):\\d+>/g, ":$1:");'''
new = '''        // Preserve Discord custom-emoji markup (<:name:id> / <a:name:id>) verbatim.
        // Replacing it with :name: lets Discord's rich-text composer reinterpret
        // pasted shortcodes and can move the emoji away from its original inline
        // position in a multi-line copied transcript.
        ;'''

count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one custom emoji rewrite, found {count}")

text = text.replace(old, new, 1)

if '.replace(/<a?:([^:]+):\\d+>/g, ":$1:")' in text:
    raise SystemExit("custom emoji shortcode rewrite still present")

path.write_text(text, encoding="utf-8")
