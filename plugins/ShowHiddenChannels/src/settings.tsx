import { ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { ErrorBoundary, Forms } from "@vendetta/ui/components";

export default () => {
    useProxy(storage);

    return (
        <ErrorBoundary>
            <ReactNative.ScrollView>
                <Forms.FormSwitchRow
                    label="Hide unread indicators"
                    subLabel="Suppress unread dots, mention counts, and unread-pin state for channels you cannot view"
                    onValueChange={(value) => storage.hideUnreads = value}
                    value={storage.hideUnreads}
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
};
