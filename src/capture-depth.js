import { Matrix4, Vector3 } from "three";
const MAX_CAPTURE_POINTS = 200_000;
// Depth is distance along the camera's -Z axis; remap depth-image UVs to view UVs.
export function depthPoint(
  u,
  v,
  meters,
  inverseDepthUV,
  inverseProjection,
  viewTransform,
) {
  const uv = new Vector3(u, v, 0).applyMatrix4(inverseDepthUV);
  return viewPoint(uv.x, uv.y, meters, inverseProjection, viewTransform);
}
function viewPoint(u, v, meters, inverseProjection, viewTransform) {
  const ray = new Vector3(u * 2 - 1, 1 - v * 2, 0.5).applyMatrix4(
    inverseProjection,
  );
  ray.multiplyScalar(meters / -ray.z);
  return ray.applyMatrix4(viewTransform);
}
export function sampleDepthPoint(depth, x, y, inverseDepthUV, inverseProjection, viewTransform) {
  // getDepthInMeters takes normalized VIEW coordinates, not depth-buffer pixels.
  // The same view ray must be used for both the depth lookup and reconstruction.
  const uv = new Vector3((x + 0.5) / depth.width, (y + 0.5) / depth.height, 0)
    .applyMatrix4(inverseDepthUV);
  if (!Number.isFinite(uv.x) || !Number.isFinite(uv.y) ||
      uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null;
  const meters = depth.getDepthInMeters(uv.x, uv.y);
  if (!Number.isFinite(meters) || meters < 0.15 || meters > 8) return null;
  const point = viewPoint(uv.x, uv.y, meters, inverseProjection, viewTransform);
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z) ? point : null;
}
function captureFailure(error) {
  const explanations = {
    NotSupportedError: "This browser cannot provide the depth data needed for room scanning. Try an updated Chrome browser on a compatible Android phone, or import a GLB or OBJ scan.",
    InvalidStateError: "Camera tracking or graphics became unavailable. Keep the browser in the foreground and try scanning again.",
    NotAllowedError: "Camera access was interrupted. Check camera permissions and try again.",
    SecurityError: "Camera depth access was blocked. Open Haven directly in your browser and check camera permissions.",
  };
  return Error(`${explanations[error.name] || `Camera depth capture failed (${error.name || "unknown error"}). Close and reopen the scan, then try again or import a scan.`} The existing scan has not changed.`, { cause: error });
}
export async function captureDepth(overlay, onProgress, { signal } = {}) {
  if (signal?.aborted) return null;
  if (!navigator.xr)
    throw Error(
      "Camera depth scanning needs a WebXR depth-enabled phone and browser. Import a GLB or OBJ scan on this device.",
    );
  return new Promise((resolve, reject) => {
    const finishButton = overlay.querySelector("[data-finish-capture]"),
      cancelButton = overlay.querySelector("[data-cancel-capture]"),
      voxels = new Set();
    let session, gl, space, failed,
      points, pointCount = 0,
      frames = 0, settled = false, stopping = false, ended = false;
    const releaseGraphics = () => {
      const context = gl;
      gl = null;
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    };
    const complete = (error, blob = null) => {
      if (settled) return;
      settled = true;
      finishButton.onclick = cancelButton.onclick = null;
      finishButton.disabled = true;
      signal?.removeEventListener("abort", cancel);
      session?.removeEventListener("end", onEnd);
      space?.removeEventListener?.("reset", onReset);
      points = null;
      voxels.clear();
      if (error) reject(error);
      else resolve(blob);
    };
    const shutdown = () => {
      if (!session || ended) {
        releaseGraphics();
        return Promise.resolve();
      }
      return Promise.resolve().then(() => session.end()).finally(releaseGraphics);
    };
    function cancel() {
      if (settled) return;
      complete(null);
      shutdown().catch(() => {});
    }
    function onEnd() {
      ended = true;
      releaseGraphics();
      if (settled) return;
      if (failed) return complete(failed);
      if (!stopping) return complete(Error(
        "Camera capture was interrupted before Finish scan. The existing scan has not changed. Try scanning again.",
      ));
      if (pointCount < 100)
        return complete(Error(
          "Not enough depth data was captured. Scan textured surfaces in good light, or import a scan.",
        ));
      complete(null, new Blob([points.subarray(0, pointCount * 3)], {
        type: "application/octet-stream",
      }));
    }
    function stop() {
      if (settled || stopping) return;
      stopping = true;
      shutdown().then(onEnd, (error) => complete(failed || captureFailure(error)));
    }
    function onReset() {
      if (settled || stopping) return;
      failed = Error("Camera tracking reset during capture. The existing scan has not changed. Start a new scan when tracking is stable.");
      stop();
    }
    finishButton.disabled = true;
    finishButton.onclick = stop;
    cancelButton.onclick = cancel;
    signal?.addEventListener("abort", cancel, { once: true });
    const frame = (_time, xrFrame) => {
      if (settled || stopping) return;
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const pose = xrFrame.getViewerPose(space);
        if (pose && frames++ % 8 === 0) {
          if (typeof xrFrame.getDepthInformation !== "function")
            throw new DOMException("CPU depth is unavailable", "NotSupportedError");
          const view = pose.views[0], depth = xrFrame.getDepthInformation(view);
          if (depth) {
            const inverseUV = new Matrix4().fromArray(depth.normDepthBufferFromNormView.matrix).invert(),
              projection = new Matrix4().fromArray(view.projectionMatrix).invert(),
              transform = new Matrix4().fromArray(view.transform.matrix);
            const step = Math.max(4, Math.ceil(Math.max(depth.width, depth.height) / 64));
            for (let y = 0; y < depth.height; y += step)
              for (let x = 0; x < depth.width; x += step) {
                const point = sampleDepthPoint(depth, x, y, inverseUV, projection, transform);
                if (!point) continue;
                const key = [point.x, point.y, point.z].map((value) => Math.round(value / 0.03)).join(",");
                if (!voxels.has(key) && pointCount < MAX_CAPTURE_POINTS) {
                  voxels.add(key);
                  const offset = pointCount * 3;
                  points[offset] = point.x;
                  points[offset + 1] = point.y;
                  points[offset + 2] = point.z;
                  pointCount++;
                }
              }
            onProgress(pointCount);
            if (pointCount >= MAX_CAPTURE_POINTS) {
              stop();
              return;
            }
          }
        }
        session.requestAnimationFrame(frame);
      } catch (error) {
        failed = captureFailure(error);
        stop();
      }
    };
    const start = async () => {
      let requesting = true;
      try {
        const acquired = await navigator.xr.requestSession("immersive-ar", {
          requiredFeatures: ["depth-sensing", "dom-overlay"],
          depthSensing: {
            usagePreference: ["cpu-optimized"],
            dataFormatPreference: ["float32", "luminance-alpha"],
          },
          domOverlay: { root: overlay },
        });
        if (settled) {
          await Promise.resolve().then(() => acquired.end()).catch(() => {});
          return;
        }
        session = acquired;
        requesting = false;
        session.addEventListener("end", onEnd, { once: true });
        gl = document.createElement("canvas").getContext("webgl2", { xrCompatible: true, alpha: true });
        if (!gl) throw Error("WebGL is unavailable.");
        await gl.makeXRCompatible();
        if (settled) return;
        session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
        space = await session.requestReferenceSpace("local");
        if (settled) return;
        space.addEventListener?.("reset", onReset);
        points = new Float32Array(MAX_CAPTURE_POINTS * 3);
        finishButton.disabled = false;
        session.requestAnimationFrame(frame);
      } catch (error) {
        if (settled) return;
        const problem = requesting
          ? Error(error.name === "NotAllowedError"
            ? "Camera access was not granted. You can try again or import a scan."
            : "This device or browser does not support WebXR camera depth scanning. Import a GLB or OBJ scan instead.")
          : captureFailure(error);
        complete(problem);
        shutdown().catch(() => {});
      }
    };
    start();
  });
}
