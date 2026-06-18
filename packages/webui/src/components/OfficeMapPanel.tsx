/**
 * OfficeMapPanel — Side panel wrapper for the office map canvas.
 * Wraps OfficeMapCanvas with ReactFlowProvider.
 */

import { ReactFlowProvider } from '@xyflow/react';
import { OfficeMapCanvas } from './OfficeMapCanvas';

export function OfficeMapPanel() {
  return (
    <ReactFlowProvider>
      <OfficeMapCanvas />
    </ReactFlowProvider>
  );
}
