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
                    label="Hide Server Boosts shortcut"
                    subLabel="Removes the Server Boosts row above channels"
                    onValueChange={(v) => storage.hideServerBoosts = v}
                    value={storage.hideServerBoosts}
                />
                <Forms.FormSwitchRow
                    label="Hide Events shortcut"
                    subLabel="Also hide the Events row when present"
                    onValueChange={(v) => storage.hideEvents = v}
                    value={storage.hideEvents}
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
};
