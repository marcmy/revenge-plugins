from pathlib import Path

path = Path("plugins/BetterChatCopy/src/index.tsx")
text = path.read_text(encoding="utf-8")

old = '''        .replace(/<@&(\\d+)>/g, (_match, id) => {
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

new = '''        .replace(/<@&(\\d+)>/g, (_match, id) => {
            const role = guildId ? GuildRoleStore?.getRole?.(guildId, id) : null;
            return role?.name ? `@${role.name}` : `@${id}`;
        })
        .replace(/<a?:([^:]+):\\d+>/g, ":$1:");'''

if text.count(old) != 1:
    raise SystemExit("expected BetterChatCopy emoji workaround block once")

text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
