import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node scripts/patch-cloud-sync.mjs <upstream-root>");

const importSheet = path.join(root, "src/plugins/cloud-sync/src/components/sheets/ImportActionSheet.tsx");
const wwyltdSheet = path.join(root, "src/plugins/cloud-sync/src/components/sheets/WwyltdSheet.tsx");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function write(file, text) {
  fs.writeFileSync(file, text, "utf8");
}

let text = read(importSheet);

text = text.replace(/import \{ Forms \} from "@vendetta\/ui\/components";\r?\n/g, "");
text = text.replace(/import \{ Button \} from "\$\/lib\/redesign";\r?\n/g, "");

const safeImportUi = `
function SafeTouchable({
disabled,
onPress,
style,
children,
}: {
disabled?: boolean;
onPress?: () => void;
style?: any;
children?: any;
}) {
const Touchable =
RN.TouchableOpacity
?? RN.TouchableHighlight
?? RN.TouchableWithoutFeedback
?? RN.View;

const props: any = {
style,
};

if (Touchable !== RN.View) {
props.disabled = disabled;
props.onPress = disabled ? undefined : onPress;
}

return <Touchable {...props}>{children}</Touchable>;
}
function SafeCheckboxRow({
\tlabel,
\tsubLabel,
\tdisabled,
\tonPress,
\tselected,
}: {
\tlabel: any;
\tsubLabel?: any;
\tdisabled?: boolean;
\tonPress?: () => void;
\tselected?: boolean;
}) {
\treturn (
\t\t<SafeTouchable
\t\t\tdisabled={disabled}
\t\t\tonPress={disabled ? undefined : onPress}
\t\t\tstyle={{
\t\t\t\topacity: disabled ? 0.45 : 1,
\t\t\t\tpaddingHorizontal: 16,
\t\t\t\tpaddingVertical: 12,
\t\t\t\tflexDirection: "row",
\t\t\t\talignItems: "center",
\t\t\t\tjustifyContent: "space-between",
\t\t\t}}
\t\t>
\t\t\t<RN.View style={{ flex: 1, marginRight: 12 }}>
\t\t\t\t{typeof label === "string" ? <RN.Text>{label}</RN.Text> : label}
\t\t\t\t{typeof subLabel === "string" ? <RN.Text>{subLabel}</RN.Text> : subLabel}
\t\t\t</RN.View>
\t\t\t<RN.Text style={{ fontSize: 20 }}>{selected ? "✓" : "○"}</RN.Text>
\t\t</SafeTouchable>
\t);
}

function SafeButton({
\ttext,
\ticon,
\tdisabled,
\tonPress,
\tstyle,
}: {
\ttext: string;
\ticon?: any;
\tdisabled?: boolean;
\tonPress?: () => void;
\tstyle?: any;
\tvariant?: string;
\tsize?: string;
\ticonPosition?: string;
}) {
\treturn (
\t\t<SafeTouchable
\t\t\tdisabled={disabled}
\t\t\tonPress={disabled ? undefined : onPress}
\t\t\tstyle={[
\t\t\t\t{
\t\t\t\t\topacity: disabled ? 0.45 : 1,
\t\t\t\t\tmarginHorizontal: 16,
\t\t\t\t\tmarginVertical: 16,
\t\t\t\t\tpaddingHorizontal: 14,
\t\t\t\t\tpaddingVertical: 10,
\t\t\t\t\tborderRadius: 8,
\t\t\t\t\talignItems: "center",
\t\t\t\t\tjustifyContent: "center",
\t\t\t\t\tflexDirection: "row",
\t\t\t\t\tbackgroundColor: "#5865f2",
\t\t\t\t},
\t\t\t\tstyle,
\t\t\t]}
\t\t>
\t\t\t{icon ? (
\t\t\t\t<RN.Image
\t\t\t\t\tsource={icon}
\t\t\t\t\tstyle={{
\t\t\t\t\t\twidth: 18,
\t\t\t\t\t\theight: 18,
\t\t\t\t\t\tmarginRight: 8,
\t\t\t\t\t\ttintColor: "white",
\t\t\t\t\t}}
\t\t\t\t\tresizeMode="contain"
\t\t\t\t/>
\t\t\t) : null}
\t\t\t<RN.Text style={{ color: "white", fontWeight: "700" }}>{text}</RN.Text>
\t\t</SafeTouchable>
\t);
}

`;

text = text.replace(/const \{ FormCheckboxRow \} = Forms;\r?\n\r?\n/g, safeImportUi);
text = text.replaceAll("<FormCheckboxRow", "<SafeCheckboxRow");
text = text.replaceAll("<Button", "<SafeButton");

write(importSheet, text);


text = read(wwyltdSheet);

text = text.replace(/import ScaleRowButton from "\$\/components\/ScaleRowButton";\r?\n/g, "");

if (!text.includes("ReactNative as RN")) {
  text = text.replace(
    /import \{ React \} from "@vendetta\/metro\/common";/,
    'import { React, ReactNative as RN } from "@vendetta/metro/common";',
  );
}

if (!text.includes('from "@vendetta/metro/common"')) {
  text = 'import { React, ReactNative as RN } from "@vendetta/metro/common";\n' + text;
}

const safeRowButton = `
function SafeTouchable({
disabled,
onPress,
style,
children,
}: {
disabled?: boolean;
onPress?: () => void;
style?: any;
children?: any;
}) {
const Touchable =
RN.TouchableOpacity
?? RN.TouchableHighlight
?? RN.TouchableWithoutFeedback
?? RN.View;

const props: any = {
style,
};

if (Touchable !== RN.View) {
props.disabled = disabled;
props.onPress = disabled ? undefined : onPress;
}

return <Touchable {...props}>{children}</Touchable>;
}
function SafeRowButton({
\tlabel,
\ticon,
\tonPress,
\tarrow,
}: {
\tlabel: any;
\ticon?: any;
\tonPress?: () => void;
\tarrow?: boolean;
}) {
\treturn (
\t\t<SafeTouchable
\t\t\tonPress={onPress}
\t\t\tstyle={{
\t\t\t\tpaddingHorizontal: 16,
\t\t\t\tpaddingVertical: 12,
\t\t\t\tborderRadius: 8,
\t\t\t\tflexDirection: "row",
\t\t\t\talignItems: "center",
\t\t\t\tjustifyContent: "space-between",
\t\t\t}}
\t\t>
\t\t\t<RN.View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
\t\t\t\t{icon ? (
\t\t\t\t\t<RN.Image
\t\t\t\t\t\tsource={icon}
\t\t\t\t\t\tstyle={{
\t\t\t\t\t\t\twidth: 20,
\t\t\t\t\t\t\theight: 20,
\t\t\t\t\t\t\tmarginRight: 12,
\t\t\t\t\t\t}}
\t\t\t\t\t\tresizeMode="contain"
\t\t\t\t\t/>
\t\t\t\t) : null}
\t\t\t\t{typeof label === "string" ? <RN.Text>{label}</RN.Text> : label}
\t\t\t</RN.View>
\t\t\t{arrow === false ? null : <RN.Text>›</RN.Text>}
\t\t</SafeTouchable>
\t);
}

`;

if (!text.includes("function SafeRowButton")) {
  const lastImport = [...text.matchAll(/^import .*;\r?$/gm)].at(-1);
  if (!lastImport) throw new Error("Could not find import block in WwyltdSheet.tsx");
  const insertAt = lastImport.index + lastImport[0].length;
  text = text.slice(0, insertAt) + "\n" + safeRowButton + text.slice(insertAt);
}

text = text.replaceAll("<ScaleRowButton", "<SafeRowButton");

write(wwyltdSheet, text);

const settingsFile = path.join(root, "src/plugins/cloud-sync/src/components/Settings.tsx");
text = read(settingsFile);

text = text.replace(/import ImportActionSheet from "\.\/sheets\/ImportActionSheet";\r?\n/g, "");
text = text.replace(/import WwyltdSheet from "\.\/sheets\/WwyltdSheet";\r?\n/g, "");

text = text.replace(
/import \{ grabEverything, setImportCallback \} from "\.\.\/stuff\/syncStuff";/,
'import { grabEverything, importData, setImportCallback } from "../stuff/syncStuff";',
);

if (!text.includes('openImportLogsPage')) {
text = text.replace(
/import IgnoredPluginsPage from "\.\/pages\/IgnoredPluginsPage";\r?\n/,
'console.log("Patched Cloud Sync legacy UI components.");import { openImportLogsPage } from "./pages/ImportLogsPage";\n',
);
}

const defaultImportOptions = `{
\t\t\t\t\t\t\tunproxiedPlugins: true,
\t\t\t\t\t\t\tplugins: true,
\t\t\t\t\t\t\tthemes: true,
\t\t\t\t\t\t\tfonts: true,
\t\t\t\t\t\t}`;

text = text.replace(
/onPress=\{\(\) => \{\s*if \(isBusy\.length\) return;\s*ActionSheet\.open\(ImportActionSheet,\s*\{\s*navigation,\s*\}\s*\);\s*setImportCallback\(x =>\s*x\s*\?\s*setBusy\("import_api"\)\s*:\s*unBusy\("import_api"\)\s*\);\s*\}\}/m,
`onPress={() => {
\t\t\t\t\tif (isBusy.length || !data) return;

\t\t\t\t\tsetImportCallback(x =>
\t\t\t\t\t\tx
\t\t\t\t\t\t\t? setBusy("import_api")
\t\t\t\t\t\t\t: unBusy("import_api")
\t\t\t\t\t);

\t\t\t\t\topenImportLogsPage(navigation);
\t\t\t\t\timportData(data, ${defaultImportOptions});
\t\t\t\t}}`,
);

text = text.replace(
/ActionSheet\.open\(WwyltdSheet,\s*\{\s*data,\s*navigation,\s*\}\s*\);/g,
`openImportLogsPage(navigation);
\t\t\t\t\t\t\timportData(data, ${defaultImportOptions});`,
);

write(settingsFile, text);
console.log("Patched Cloud Sync legacy UI components and bypassed import sheets.");




