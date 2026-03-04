import { ReactNative } from "@vendetta/metro/common";
import { ErrorBoundary, Forms } from "@vendetta/ui/components";
import { useProxy } from "@vendetta/storage";
import { storage } from "@vendetta/plugin";

export default () => {
    useProxy(storage);

    return (
    <ErrorBoundary>
        <ReactNative.ScrollView>
            <Forms.FormSwitchRow
                label="Split messages on words instead of newlines"
                subLabel="Results in the lowest amount of messages"
                onValueChange={(v) => storage.splitOnWords = v}
                value={storage.splitOnWords}
            />
            <Forms.FormSwitchRow
                label="Fix plain pasted lists"
                subLabel="Tries to restore markdown bullets for plain ChatGPT-style list blocks"
                onValueChange={(v) => storage.fixPlainLists = v}
                value={storage.fixPlainLists}
            />
        </ReactNative.ScrollView>
    </ErrorBoundary>
    );
};
