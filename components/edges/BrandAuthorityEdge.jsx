import { BaseEdge, getSmoothStepPath } from 'reactflow';

export default function BrandAuthorityEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 0,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: 'var(--c-coral-600)',
          strokeWidth: 1.2,
          strokeDasharray: '4 4',
        }}
      />
      <text
        x={labelX}
        y={labelY - 8}
        textAnchor="middle"
        fill="var(--c-coral-600)"
        fontSize={10}
        className="react-flow__edge-label"
      >
        brand authority
      </text>
    </>
  );
}
