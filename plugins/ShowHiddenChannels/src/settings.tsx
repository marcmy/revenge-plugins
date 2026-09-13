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
                <Forms.FormRow
                    label="Display style"
                    subLabel="Lock/inaccessible style. Muted styling is intentionally disabled until Discord exposes a stable mobile row hook."
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
};
