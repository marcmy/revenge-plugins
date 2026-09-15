import { storage } from "@vendetta/plugin";

type MessageHistoryRuntimeBinding = {
    clearAllHistory: () => void;
    requestOverlayRefresh: () => void;
};

let binding: MessageHistoryRuntimeBinding | undefined;

export function bindMessageHistoryRuntime(next: MessageHistoryRuntimeBinding): () => void {
    binding = next;
    return () => {
        if (binding === next) binding = undefined;
    };
}

export function clearAllHistoryRuntime(): void {
    if (binding) {
        binding.clearAllHistory();
        return;
    }

    storage.historyRecords = [];
}

export function requestMessageHistoryOverlayRefresh(): void {
    binding?.requestOverlayRefresh();
}
