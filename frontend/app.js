// Wikipedia Graph Visualizer - WebGL2 Engine
document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('graphCanvas');
  const nodeCountEl = document.getElementById('nodeCount');
  const edgeCountEl = document.getElementById('edgeCount');
  const statusEl = document.getElementById('status');

  // Resize canvas display buffer to match window/CSS sizing
  function resizeCanvas() {
    canvas.width = canvas.clientWidth || window.innerWidth;
    canvas.height = canvas.clientHeight || window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const gl = canvas.getContext('webgl2');
  if (!gl) {
    statusEl.innerText = 'Error: WebGL 2 not supported.';
    console.error('WebGL 2 is not supported by your browser.');
    return;
  }

  // -----------------------------------------------------------------------------
  // 1. GLSL ES 3.00 Shaders
  // -----------------------------------------------------------------------------

  // Node Shaders (Point Sprites with Pan/Zoom support)
  const nodeVsSource = `#version 300 es
  in vec2 a_position;

  uniform vec2 u_resolution;
  uniform vec2 u_pan;
  uniform float u_zoom;
  uniform float u_pointSize;

  void main() {
    // Apply pan and zoom camera transformations
    vec2 transformedPos = (a_position + u_pan) * u_zoom;

    // Convert pixels to Clip Space (NDC: -1.0 to 1.0)
    vec2 zeroToOne = transformedPos / u_resolution;
    vec2 zeroToTwo = zeroToOne * 2.0;
    vec2 clipSpace = zeroToTwo - 1.0;

    gl_Position = vec4(clipSpace.x, -clipSpace.y, 0.0, 1.0);
    gl_PointSize = u_pointSize * u_zoom;
  }
  `;

  const nodeFsSource = `#version 300 es
  precision highp float;

  uniform vec4 u_color;
  out vec4 outColor;

  void main() {
    // Smooth anti-aliased circle inside gl_PointCoord space
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    float delta = fwidth(dist);
    float alpha = 1.0 - smoothstep(0.5 - delta, 0.5, dist);

    if (alpha <= 0.0) discard;
    outColor = vec4(u_color.rgb, u_color.a * alpha);
  }
  `;

  // Edge Shaders (Line Segments)
  const edgeVsSource = `#version 300 es
    in vec2 a_position;

    uniform vec2 u_resolution;
    uniform vec2 u_pan;
    uniform float u_zoom;

    void main() {
      vec2 transformedPos = (a_position + u_pan) * u_zoom;
      vec2 zeroToOne = transformedPos / u_resolution;
      vec2 zeroToTwo = zeroToOne * 2.0;
      vec2 clipSpace = zeroToTwo - 1.0;

      gl_Position = vec4(clipSpace.x, -clipSpace.y, 0.0, 1.0);
    }
    `;

    const edgeFsSource = `#version 300 es
    precision highp float;

    uniform vec4 u_color;

    out vec4 outColor;

    void main() {
      outColor = u_color;
    }
    `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(gl, vsSource, fsSource) {
    const program = gl.createProgram();
    gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    return program;
  }

  const nodeProgram = createProgram(gl, nodeVsSource, nodeFsSource);
  const edgeProgram = createProgram(gl, edgeVsSource, edgeFsSource);

  // Uniform & Attribute Locations
  const nodePosLoc = gl.getAttribLocation(nodeProgram, 'a_position');
  const nodeResLoc = gl.getUniformLocation(nodeProgram, 'u_resolution');
  const nodePanLoc = gl.getUniformLocation(nodeProgram, 'u_pan');
  const nodeZoomLoc = gl.getUniformLocation(nodeProgram, 'u_zoom');
  const nodeSizeLoc = gl.getUniformLocation(nodeProgram, 'u_pointSize');
  const nodeColorLoc = gl.getUniformLocation(nodeProgram, 'u_color');

  const edgePosLoc = gl.getAttribLocation(edgeProgram, 'a_position');
  const edgeResLoc = gl.getUniformLocation(edgeProgram, 'u_resolution');
  const edgePanLoc = gl.getUniformLocation(edgeProgram, 'u_pan');
  const edgeZoomLoc = gl.getUniformLocation(edgeProgram, 'u_zoom');
  const edgeColorLoc = gl.getUniformLocation(edgeProgram, 'u_color');

  // -----------------------------------------------------------------------------
  // 2. Camera Controls (Pan & Zoom state)
  // -----------------------------------------------------------------------------
  const camera = {
    panX: 0,
    panY: 0,
    zoom: 1.0,
    isDragging: false,
    lastMouseX: 0,
    lastMouseY: 0,
  };

  canvas.addEventListener('mousedown', (e) => {
    camera.isDragging = true;
    camera.lastMouseX = e.clientX;
    camera.lastMouseY = e.clientY;
  });

  window.addEventListener('mouseup', () => {
    camera.isDragging = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!camera.isDragging) return;
    const dx = e.clientX - camera.lastMouseX;
    const dy = e.clientY - camera.lastMouseY;
    camera.panX += dx / camera.zoom;
    camera.panY += dy / camera.zoom;
    camera.lastMouseX = e.clientX;
    camera.lastMouseY = e.clientY;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    camera.zoom = Math.max(0.1, Math.min(camera.zoom * zoomFactor, 10.0));
  }, { passive: false });

  // -----------------------------------------------------------------------------
  // 3. Graph Data Generator (Mocking Neo4j / MongoDB export payload)
  // -----------------------------------------------------------------------------
  statusEl.innerText = 'Initializing network graph topology...';

  const NUM_NODES = 1200;
  const nodes = [];
  const nodePositions = new Float32Array(NUM_NODES * 2);

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  // Initialize cluster network nodes
  for (let i = 0; i < NUM_NODES; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.sqrt(Math.random()) * 400; // Radial cluster
    const x = centerX + Math.cos(angle) * distance;
    const y = centerY + Math.sin(angle) * distance;

    nodes.push({ x, y, vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10 });
    nodePositions[i * 2] = x;
    nodePositions[i * 2 + 1] = y;
  }

  // Generate random directed/undirected edges
  const edgeIndices = [];
  for (let i = 0; i < NUM_NODES; i++) {
    const connections = Math.floor(Math.random() * 3) + 1;
    for (let c = 0; c < connections; c++) {
      const target = Math.floor(Math.random() * NUM_NODES);
      if (target !== i) {
        edgeIndices.push(i, target);
      }
    }
  }
  const edgeVertices = new Float32Array(edgeIndices.length * 2);

  // Update UI Stats
  nodeCountEl.innerText = NUM_NODES.toLocaleString();
  edgeCountEl.innerText = (edgeIndices.length / 2).toLocaleString();
  statusEl.innerText = 'Rendering active network';

  // -----------------------------------------------------------------------------
  // 4. WebGL Buffers & VAOs
  // -----------------------------------------------------------------------------
  // Nodes setup
  const nodeVao = gl.createVertexArray();
  const nodeBuffer = gl.createBuffer();
  gl.bindVertexArray(nodeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, nodePositions, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(nodePosLoc);
  gl.vertexAttribPointer(nodePosLoc, 2, gl.FLOAT, false, 0, 0);

  // Edges setup
  const edgeVao = gl.createVertexArray();
  const edgeBuffer = gl.createBuffer();
  gl.bindVertexArray(edgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, edgeVertices.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(edgePosLoc);
  gl.vertexAttribPointer(edgePosLoc, 2, gl.FLOAT, false, 0, 0);

  // Alpha Blending for smooth edges and translucent links
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // -----------------------------------------------------------------------------
  // 5. Render Loop
  // -----------------------------------------------------------------------------
  function updateGraphPositions() {
    // Update node positions and compute edge endpoints
    for (let i = 0; i < NUM_NODES; i++) {
      const n = nodes[i];
      n.x += n.vx * 0.016;
      n.y += n.vy * 0.016;

      // Soft boundary repulsion
      if (n.x < 50 || n.x > canvas.width - 50) n.vx *= -1;
      if (n.y < 50 || n.y > canvas.height - 50) n.vy *= -1;

      nodePositions[i * 2] = n.x;
      nodePositions[i * 2 + 1] = n.y;
    }

    // Populate lines with node coordinates
    for (let i = 0; i < edgeIndices.length; i++) {
      const nodeIdx = edgeIndices[i];
      edgeVertices[i * 2] = nodes[nodeIdx].x;
      edgeVertices[i * 2 + 1] = nodes[nodeIdx].y;
    }
  }

  function render() {
    updateGraphPositions();

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.07, 0.08, 0.11, 1.0); // Dark background matching graph UI
    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- 1. Draw Edges ---
    gl.useProgram(edgeProgram);
    gl.bindVertexArray(edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeVertices);

    gl.uniform2f(edgeResLoc, canvas.width, canvas.height);
    gl.uniform2f(edgePanLoc, camera.panX, camera.panY);
    gl.uniform1f(edgeZoomLoc, camera.zoom);
    gl.uniform4f(edgeColorLoc, 0.25, 0.65, 0.65, 0.18); // Teal translucent lines
    gl.drawArrays(gl.LINES, 0, edgeIndices.length);

    // --- 2. Draw Nodes ---
    gl.useProgram(nodeProgram);
    gl.bindVertexArray(nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, nodePositions);

    gl.uniform2f(nodeResLoc, canvas.width, canvas.height);
    gl.uniform2f(nodePanLoc, camera.panX, camera.panY);
    gl.uniform1f(nodeZoomLoc, camera.zoom);
    gl.uniform1f(nodeSizeLoc, 6.0); // Base node point size
    gl.uniform4f(nodeColorLoc, 0.4, 0.98, 0.94, 0.85); // Bright cyan nodes
    gl.drawArrays(gl.POINTS, 0, NUM_NODES);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
});
