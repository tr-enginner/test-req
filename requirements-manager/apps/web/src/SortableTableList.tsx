import type {ReactNode} from "react";
import {DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent} from "@dnd-kit/core";
import {SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy} from "@dnd-kit/sortable";
import {CSS} from "@dnd-kit/utilities";
import {HolderOutlined} from "@ant-design/icons";
import {reorderTableIds, uniqueTableIds} from "./tableOrder";

function SortableTableItem({id, index, children}: {id: string; index: number; children: ReactNode}) {
    const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id});
    return <div ref={setNodeRef} className={`phase2-sortable-table-item${isDragging ? " is-dragging" : ""}`}
                style={{transform: CSS.Transform.toString(transform), transition}}>
        <button type="button" className="phase2-table-drag-handle" aria-label={`拖动第 ${index + 1} 张表格调整顺序`}
                {...attributes} {...listeners}><HolderOutlined/></button>
        <span className="phase2-table-order" aria-hidden="true">{index + 1}</span>
        <div className="phase2-sortable-table-content">{children}</div>
    </div>
}

export function SortableTableList({ids, onChange, children, className = ""}: {
    ids: string[];
    onChange: (ids: string[]) => void;
    children: (id: string, index: number) => ReactNode;
    className?: string;
}) {
    const orderedIds = uniqueTableIds(ids);
    const sensors = useSensors(
        useSensor(PointerSensor, {activationConstraint: {distance: 6}}),
        useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}),
    );
    const finishDrag = ({active, over}: DragEndEvent) => {
        if (!over || active.id === over.id) return;
        const next = reorderTableIds(orderedIds, String(active.id), String(over.id));
        if (next.some((value, index) => value !== orderedIds[index])) onChange(next)
    };
    return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={finishDrag}>
        <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
            <div className={`phase2-sortable-table-list ${className}`.trim()}>
                {orderedIds.map((id, index) => <SortableTableItem id={id} index={index} key={id}>{children(id, index)}</SortableTableItem>)}
            </div>
        </SortableContext>
    </DndContext>
}
