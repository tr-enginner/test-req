import {create} from "zustand";

type TraceState = {
    activeSourceNodeId?: string;
    activeRequirementId?: string;
    setSource: (id?: string) => void;
    setRequirement: (id?: string) => void;
};

export const useTraceStore = create<TraceState>(set => ({
    setSource: activeSourceNodeId => set({activeSourceNodeId}),
    setRequirement: activeRequirementId => set({activeRequirementId})
}));
