import { Handle, Position } from 'reactflow';
import { formatUSD } from '../../synth.js';

export default function BrandNode({ data, selected }) {
  const { node, role, onSelect } = data;
  const rev = node.revenue_estimate;
  const isFocal = role === 'focal';
  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };

  return (
    <div
      className={`flow-node brand ${isFocal ? 'focal' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect?.(node.company)}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div className="flow-node-name">{node.company}</div>
      {node.domain && <div className="flow-node-domain">{node.domain}</div>}
      <div className="flow-node-meta">
        <span className={`chip ${isFocal ? 'chip-accent' : ''}`}>{role}</span>
        {node.category && <span className="chip">{node.category}</span>}
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
