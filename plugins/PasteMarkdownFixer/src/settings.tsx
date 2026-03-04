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
                    label="Fix lists in drafts"
                    subLabel="Normalize likely plain list blocks while draft text is saved"
                    onValueChange={(v) => storage.fixListsInDraft = v}
                    value={storage.fixListsInDraft}
                />
                <Forms.FormSwitchRow
                    label="Fix lists on send"
                    subLabel="Normalize likely plain list blocks immediately before send"
                    onValueChange={(v) => storage.fixListsOnSend = v}
                    value={storage.fixListsOnSend}
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
};
