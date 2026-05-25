import { Handle, Position } from 'reactflow';
import { formatUSD } from '../../synth.js';

// C1 — 8th node type: house_of_brands_aggregator. Visually distinct from the
// divisional AggregatorNode (solid teal border + portfolio glyph) because a
// holding company OWNS its brands as children, it is not just a reporting cut.
export default function HoldingNode({ data, selected }) {
  const { node, role, onSelect } = data;
  const rev = node.revenue_estimate;
  const isFocal = role === 'focal';
  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };
  const childCount = (node.children || []).length;

  return (
    <div
      className={`flow-node holding ${isFocal ? 'focal' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect?.(node.company)}
      style={{
        backgroundColor: 'var(--c-teal-50)',
        borderStyle: 'solid',
        borderWidth: 1.5,
        borderColor: 'var(--c-teal-400)',
      }}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div className="flow-node-name">▤ {node.company}</div>
      <div className="flow-node-meta">
        <span className="chip" style={{ backgroundColor: 'var(--c-teal-400)', color: '#fff' }}>HOUSE OF BRANDS</span>
        {childCount > 0 && <span className="chip">{childCount} brands</span>}
        {rev && rev.central > 0 && (
          <>
            <span className={`confidence-dot confidence-${rev.confidence || 'low'}`} />
            <span className="flow-node-rev">{formatUSD(rev.central)}</span>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}
