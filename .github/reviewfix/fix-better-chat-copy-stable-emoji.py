from pathlib import Path

path = Path("plugins/BetterChatCopy/src/index.tsx")
text = path.read_text(encoding="utf-8")

old = '''        .replace(/<@&(\\d+)>/g, (_match, id) => {
            const role = guildId ? GuildRoleStore?.getRole?.(guildId, id) : null;
            return role?.name ? `@${role.name}` : `@${id}`;
        });'''

new = '''        .replace(/<@&(\\d+)>/g, (_match, id) => {
            const role = guildId ? GuildRoleStore?.getRole?.(guildId, id) : null;
            return role?.name ? `@${role.name}` : `@${id}`;
        })
        .replace(/<a?:([^:]+):\\d+>/g, (_match, name) => {
            // Discord mobile promotes pasted custom-emoji tokens into rich
            // editor nodes and can relocate those nodes to the end of a
            // multi-line paste. A WORD JOINER keeps the shortcode visually
            // identical while preventing that parser from recognizing it.
            return `:\\u2060${name}:`;
        });'''

count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one role-replacement tail, found {count}")

text = text.replace(old, new, 1)

if 'replace(/<a?:([^:]+):\\d+>/g' not in text:
    raise SystemExit("custom emoji stabilization replacement missing")

path.write_text(text, encoding="utf-8")
