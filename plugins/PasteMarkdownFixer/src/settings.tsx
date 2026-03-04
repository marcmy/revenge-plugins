import { React, ReactNative } from "@vendetta/metro/common";
import { ErrorBoundary, Forms } from "@vendetta/ui/components";

import { fixAndSendCurrentDraft, fixCurrentDraft } from "./actions";

function ActionButton(props: { label: string; onPress: () => void }) {
    return (
        <ReactNative.Pressable
            onPress={props.onPress}
            style={{
                backgroundColor: "#5865F2",
                borderRadius: 10,
                marginHorizontal: 16,
                marginTop: 12,
                paddingVertical: 12,
                paddingHorizontal: 14,
            }}
        >
            <ReactNative.Text style={{ color: "white", fontWeight: "700", textAlign: "center" }}>
                {props.label}
            </ReactNative.Text>
        </ReactNative.Pressable>
    );
}

export default () => {
    return (
        <ErrorBoundary>
            <ReactNative.ScrollView>
                <Forms.FormSection title="Manual Actions">
                    <Forms.FormText>
                        Use these actions from an open channel to rewrite the current draft with markdown-friendly bullets.
                    </Forms.FormText>
                </Forms.FormSection>

                <ActionButton label="Fix Current Draft" onPress={fixCurrentDraft} />
                <ActionButton label="Fix + Send Current Draft" onPress={fixAndSendCurrentDraft} />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
};
