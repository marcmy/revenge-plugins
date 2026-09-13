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
                    label="Hide hidden-channel unreads"
                    subLabel="Suppress unread indicators for inaccessible channels"
                    onValueChange={(value) => storage.hideUnreads = value}
                    value={storage.hideUnreads}
                />
                <Forms.FormSwitchRow
                    label="Show hidden-channel info screen"
                    subLabel="Open a read-only information view instead of normal chat"
                    onValueChange={(value) => storage.showInfoScreen = value}
                    value={storage.showInfoScreen}
                />
                <Forms.FormRadioRow
                    label="Lock style"
                    subLabel="Use the normal channel row with its inaccessible/lock presentation"
                    selected={storage.displayMode === "lock"}
                    onPress={() => storage.displayMode = "lock"}
                />
                <Forms.FormRadioRow
                    label="Muted style"
                    subLabel="Use a subdued row style when the current Discord renderer exposes a safe hook"
                    selected={storage.displayMode === "muted"}
                    onPress={() => storage.displayMode = "muted"}
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
};
