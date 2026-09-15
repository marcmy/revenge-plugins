import fs from "node:fs";

const source = fs.readFileSync("plugins/ShowHiddenChannels/src/index.ts", "utf8");
const hookPatch = /instead\(\s*"useIsChannelMetadataObfuscationEnabled"\s*,\s*PrivateChannelHidingExperiment\s*,\s*\(args,\s*orig\)\s*=>\s*\{[\s\S]*?orig\(\.\.\.args\);[\s\S]*?return false;[\s\S]*?\}\s*\)/m;

if (!hookPatch.test(source)) {
    console.error(
        "ShowHiddenChannels must call the original useIsChannelMetadataObfuscationEnabled hook before forcing false, otherwise React hook order can change between renders.",
    );
    process.exit(1);
}

console.log("ShowHiddenChannels custom-hook override preserves React hook order.");
