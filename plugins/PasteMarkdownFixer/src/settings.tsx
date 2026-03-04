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
                    label="Recover in drafts"
                    subLabel="Use recently-read clipboard text when draft saves look flattened"
                    onValueChange={(v) => storage.recoverInDraft = v}
                    value={storage.recoverInDraft}
                />
                <Forms.FormSwitchRow
                    label="Recover on send"
                    subLabel="Use recently-read clipboard text when outgoing content looks flattened"
                    onValueChange={(v) => storage.recoverOnSend = v}
                    value={storage.recoverOnSend}
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
};
