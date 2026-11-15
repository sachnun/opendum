type TetrisCell = string | null;

type TetrisPiece = {
  shape: number[][];
  targetShape: number[][];
  targetX: number;
  color: string;
  x: number;
  y: number;
  drawX: number;
  drawY: number;
};

const MAX_PIECES = 1;

const TETRIS_PIECES = [
  { shape: [[1, 1, 1, 1]], color: "rgba(226, 232, 240, 0.12)" },
  { shape: [[1, 1], [1, 1]], color: "rgba(203, 213, 225, 0.11)" },
  { shape: [[0, 1, 0], [1, 1, 1]], color: "rgba(241, 245, 249, 0.10)" },
  { shape: [[1, 0, 0], [1, 1, 1]], color: "rgba(209, 213, 219, 0.10)" },
  { shape: [[0, 0, 1], [1, 1, 1]], color: "rgba(229, 231, 235, 0.10)" },
  { shape: [[0, 1, 1], [1, 1, 0]], color: "rgba(156, 163, 175, 0.11)" },
  { shape: [[1, 1, 0], [0, 1, 1]], color: "rgba(148, 163, 184, 0.10)" },
];

function rotateShape(shape: number[][]): number[][] {
  const width = shape[0]?.length ?? 0;
  return Array.from({ length: width }, (_, columnIndex) => shape.map((row) => row[columnIndex] ?? 0).reverse());
}

export function startTetrisBackground(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => undefined;

  const surface = canvas;
  const ctx = context;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let animationFrame = 0;
  let columns = 0;
  let rows = 0;
  let cellSize = 18;
  let board: TetrisCell[][] = [];
  let activePieces: TetrisPiece[] = [];
  let lastFrame = performance.now();
  let dropTimer = 0;
  let driftTimer = 0;
  let spawnTimer = 0;

  function viewportSize() {
    const visualViewport = window.visualViewport;
    return {
      width: visualViewport?.width ?? window.innerWidth,
      height: visualViewport?.height ?? window.innerHeight,
    };
  }

  function createBoard() {
    board = Array.from({ length: rows }, () => Array<TetrisCell>(columns).fill(null));
  }

  function seedStack() {
    const stackHeight = Math.min(rows - 6, Math.max(5, Math.floor(rows * 0.22)));
    const colors = TETRIS_PIECES.map((piece) => piece.color);
    const wavePhase = Math.random() * Math.PI * 2;
    const columnHeights = Array.from({ length: columns }, (_, x) => {
      const progress = x / Math.max(1, columns - 1);
      const wave =
        Math.sin(progress * Math.PI * 2.4 + wavePhase) * 0.5 + Math.sin(progress * Math.PI * 5.2 + wavePhase * 0.6) * 0.22;
      const edgeFalloff = Math.sin(progress * Math.PI) * 0.9 + 0.1;
      const targetHeight = stackHeight * (0.38 + edgeFalloff * 0.28 + wave * 0.22);

      return Math.max(1, Math.min(stackHeight, Math.round(targetHeight)));
    });

    for (let rowOffset = 0; rowOffset < stackHeight; rowOffset += 1) {
      const y = rows - 1 - rowOffset;

      for (let x = 0; x < columns; x += 1) {
        const waveGap = Math.floor((Math.sin(rowOffset * 0.9 + wavePhase) * 0.5 + 0.5) * (columns - 5)) + 2;
        const isWaveGap = Math.abs(x - waveGap) <= (rowOffset % 5 === 0 ? 1 : 0);
        const isSmallGap =
          rowOffset > 1 && rowOffset < stackHeight - 1 && (x * 3 + rowOffset) % 17 === 0 && Math.random() > 0.7;

        const row = board[y];
        const height = columnHeights[x] ?? 0;
        const color = colors[(x + Math.floor(rowOffset / 2)) % colors.length];
        if (!isWaveGap && !isSmallGap && rowOffset < height && row && color !== undefined) {
          row[x] = color;
        }
      }

      const row = board[y];
      if (row?.every(Boolean)) {
        row[Math.floor((columns - 1) / 2)] = null;
      }
    }
  }

  function fits(shape: number[][], nextX: number, nextY: number) {
    return shape.every((shapeRow, shapeY) =>
      shapeRow.every((cell, shapeX) => {
        if (!cell) return true;

        const boardX = nextX + shapeX;
        const boardY = nextY + shapeY;

        return boardX >= 0 && boardX < columns && boardY < rows && (boardY < 0 || !board[boardY]?.[boardX]);
      })
    );
  }

  function canPlace(piece: TetrisPiece, nextX = piece.x, nextY = piece.y, shape = piece.shape) {
    return fits(shape, nextX, nextY);
  }

  function shapesEqual(first: number[][], second: number[][]) {
    return first.length === second.length && first.every((row, rowIndex) => row.join("") === second[rowIndex]?.join(""));
  }

  function rotationsOf(shape: number[][]) {
    const rotations: number[][][] = [];
    let nextShape = shape;

    for (let index = 0; index < 4; index += 1) {
      const candidate = nextShape;
      if (!rotations.some((rotation) => shapesEqual(rotation, candidate))) rotations.push(candidate);
      nextShape = rotateShape(nextShape);
    }

    return rotations;
  }

  function scoreLanding(shape: number[][], x: number, y: number) {
    const testBoard = board.map((row) => [...row]);

    shape.forEach((shapeRow, shapeY) => {
      shapeRow.forEach((cell, shapeX) => {
        const boardX = x + shapeX;
        const boardY = y + shapeY;

        if (cell && boardY >= 0 && boardY < rows && boardX >= 0 && boardX < columns) {
          const row = testBoard[boardY];
          if (row) row[boardX] = "preview";
        }
      });
    });

    const completedLines = testBoard.filter((row) => row.every(Boolean)).length;
    const heights = Array.from({ length: columns }, (_, column) => {
      const firstBlock = testBoard.findIndex((row) => Boolean(row[column]));
      return firstBlock === -1 ? 0 : rows - firstBlock;
    });
    const aggregateHeight = heights.reduce((total, height) => total + height, 0);
    const bumpiness = heights
      .slice(1)
      .reduce((total, height, index) => total + Math.abs(height - (heights[index] ?? 0)), 0);
    let holes = 0;

    for (let column = 0; column < columns; column += 1) {
      let hasBlock = false;
      for (let row = 0; row < rows; row += 1) {
        if (testBoard[row]?.[column]) hasBlock = true;
        else if (hasBlock) holes += 1;
      }
    }

    return completedLines * 90 - aggregateHeight * 2.2 - holes * 12 - bumpiness * 3 + Math.random() * 4;
  }

  function bestMove(shape: number[][]) {
    let best: { shape: number[][]; x: number; score: number } | null = null;

    rotationsOf(shape).forEach((rotation) => {
      const maxX = columns - (rotation[0]?.length ?? 0);
      for (let x = 0; x <= maxX; x += 1) {
        let y = -rotation.length;

        while (fits(rotation, x, y + 1)) y += 1;

        if (!fits(rotation, x, y)) continue;

        const score = scoreLanding(rotation, x, y);
        if (!best || score > best.score) best = { shape: rotation, x, score };
      }
    });

    return best ?? { shape, x: Math.max(0, Math.floor((columns - (shape[0]?.length ?? 0)) / 2)), score: 0 };
  }

  function planPiece(piece: TetrisPiece) {
    const move = bestMove(piece.shape);
    piece.targetShape = move.shape;
    piece.targetX = move.x;
  }

  function ready(piece: TetrisPiece) {
    return piece.x === piece.targetX && shapesEqual(piece.shape, piece.targetShape);
  }

  function hardDrop(piece: TetrisPiece) {
    while (canPlace(piece, piece.x, piece.y + 1)) piece.y += 1;
    piece.drawX = piece.x;
    piece.drawY = piece.y;
  }

  function spawnPiece() {
    const source = TETRIS_PIECES[Math.floor(Math.random() * TETRIS_PIECES.length)] ?? TETRIS_PIECES[0];
    if (!source) return;
    const shape = source.shape;
    const pieceWidth = shape[0]?.length ?? 0;
    const targetMove = bestMove(shape);
    const x = Math.max(0, Math.floor((columns - pieceWidth) / 2));
    const y = -shape.length;

    activePieces.push({
      shape,
      targetShape: targetMove.shape,
      targetX: targetMove.x,
      color: source.color,
      x,
      y,
      drawX: x,
      drawY: y,
    });
  }

  function lockPiece(piece: TetrisPiece) {
    piece.shape.forEach((shapeRow, shapeY) => {
      shapeRow.forEach((cell, shapeX) => {
        const boardX = piece.x + shapeX;
        const boardY = piece.y + shapeY;

        if (cell && boardY >= 0 && boardY < rows && boardX >= 0 && boardX < columns) {
          const row = board[boardY];
          if (row) row[boardX] = piece.color;
        }
      });
    });

    board = board.filter((row) => row.some((cell) => !cell));
    while (board.length < rows) board.unshift(Array<TetrisCell>(columns).fill(null));

    if (board.slice(0, 4).some((row) => row.some(Boolean))) createBoard();
  }

  function resizeCanvas() {
    const { width, height } = viewportSize();
    const ratio = window.devicePixelRatio || 1;

    cellSize = width < 640 ? 14 : 18;
    columns = Math.max(12, Math.ceil(width / cellSize));
    rows = Math.max(18, Math.ceil(height / cellSize));
    surface.width = Math.ceil(width * ratio);
    surface.height = Math.ceil(height * ratio);
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    createBoard();
    seedStack();
    activePieces = [];
    for (let index = 0; index < MAX_PIECES; index += 1) spawnPiece();
  }

  function drawBlock(x: number, y: number, color: string) {
    const inset = 1.5;
    const size = cellSize - inset * 2;

    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.035)";
    ctx.lineWidth = 1;
    ctx.fillRect(x * cellSize + inset, y * cellSize + inset, size, size);
    ctx.strokeRect(x * cellSize + inset, y * cellSize + inset, size, size);
  }

  function draw() {
    ctx.clearRect(0, 0, surface.width, surface.height);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.018)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= columns; x += 1) {
      ctx.beginPath();
      ctx.moveTo(x * cellSize, 0);
      ctx.lineTo(x * cellSize, rows * cellSize);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y += 1) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellSize);
      ctx.lineTo(columns * cellSize, y * cellSize);
      ctx.stroke();
    }

    board.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell) drawBlock(x, y, cell);
      });
    });

    activePieces.forEach((piece) => {
      piece.shape.forEach((shapeRow, shapeY) => {
        shapeRow.forEach((cell, shapeX) => {
          const drawX = Math.round(piece.drawX * 2) / 2;
          const drawY = Math.round(piece.drawY * 2) / 2;
          const y = drawY + shapeY;

          if (cell && y >= 0) drawBlock(drawX + shapeX, y, piece.color);
        });
      });
    });
  }

  function tick(time: number) {
    const delta = time - lastFrame;
    lastFrame = time;
    dropTimer += delta;
    driftTimer += delta;
    spawnTimer += delta;

    if (!reducedMotion) {
      activePieces.forEach((piece) => {
        const ease = Math.min(1, delta / 55);
        piece.drawX += (piece.x - piece.drawX) * ease;
        piece.drawY += (piece.y - piece.drawY) * Math.min(1, delta / 75);
      });

      if (spawnTimer > 210 && activePieces.length < MAX_PIECES) {
        spawnTimer = 0;
        spawnPiece();
      }

      if (driftTimer > 120) {
        driftTimer = 0;
        activePieces.forEach((piece) => {
          if (!shapesEqual(piece.shape, piece.targetShape) && canPlace(piece, piece.x, piece.y, piece.targetShape)) {
            piece.shape = piece.targetShape;
          }

          const urgency = Math.abs(piece.targetX - piece.x);
          const horizontalSteps = urgency > 8 ? 3 : urgency > 3 ? 2 : 1;

          for (let step = 0; step < horizontalSteps; step += 1) {
            const nextX = piece.x + Math.sign(piece.targetX - piece.x);
            if (nextX === piece.x) break;

            if (canPlace(piece, nextX, piece.y)) {
              piece.x = nextX;
            } else {
              planPiece(piece);
              break;
            }
          }
        });
      }

      if (dropTimer > 85) {
        dropTimer = 0;
        let didLockPiece = false;

        for (let index = activePieces.length - 1; index >= 0; index -= 1) {
          const piece = activePieces[index];
          if (!piece) continue;

          if (ready(piece)) {
            hardDrop(piece);
            lockPiece(piece);
            activePieces.splice(index, 1);
            didLockPiece = true;
            continue;
          }

          if (canPlace(piece, piece.x, piece.y + 1)) {
            piece.y += 1;
          } else {
            lockPiece(piece);
            activePieces.splice(index, 1);
            didLockPiece = true;
          }
        }

        if (didLockPiece) activePieces.forEach(planPiece);
      }
    }

    draw();
    animationFrame = window.requestAnimationFrame(tick);
  }

  resizeCanvas();
  draw();

  if (!reducedMotion) animationFrame = window.requestAnimationFrame(tick);

  window.addEventListener("resize", resizeCanvas);
  window.visualViewport?.addEventListener("resize", resizeCanvas);

  return () => {
    window.cancelAnimationFrame(animationFrame);
    window.removeEventListener("resize", resizeCanvas);
    window.visualViewport?.removeEventListener("resize", resizeCanvas);
  };
}
