from pathlib import Path

path = Path("plugins/BetterChatCopy/src/index.tsx")
text = path.read_text(encoding="utf-8")

old = '''        .replace(/<@&(\\d+)>/g, (_match, id) => {
            const role = guildId ? GuildRoleStore?.getRole?.(guildId, id) : null;
            return role?.name ? `@${role.name}` : `@${id}`;
        })
        // Preserve Discord custom-emoji markup (<:name:id> / <a:name:id>) verbatim.
        // Replacing it with :name: lets Discord's rich-text composer reinterpret
        // pasted shortcodes and can move the emoji away from its original inline
        // position in a multi-line copied transcript.
        ;'''

new = '''        .replace(/<@&(\\d+)>/g, (_match, id) => {
            const role = guildId ? GuildRoleStore?.getRole?.(guildId, id) : null;
            return role?.name ? `@${role.name}` : `@${id}`;
        });'''

count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one formatting block, found {count}")

text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
