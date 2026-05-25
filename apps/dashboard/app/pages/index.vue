<script setup lang="ts">
import { signIn, useSession } from "../../lib/auth-client";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "We could not link this sign-in method to your existing account. Try your original provider once, then try again.",
  AccessDenied: "Access denied. Please try signing in again.",
  CredentialsSignin: "Local development sign in failed. Please try again.",
};

type SocialProvider = "github" | "google";
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

const maxVisibleTetrisPieces = 1;

const tetrisPieces = [
  { shape: [[1, 1, 1, 1]], color: "rgba(226, 232, 240, 0.12)" },
  { shape: [[1, 1], [1, 1]], color: "rgba(203, 213, 225, 0.11)" },
  { shape: [[0, 1, 0], [1, 1, 1]], color: "rgba(241, 245, 249, 0.10)" },
  { shape: [[1, 0, 0], [1, 1, 1]], color: "rgba(209, 213, 219, 0.10)" },
  { shape: [[0, 0, 1], [1, 1, 1]], color: "rgba(229, 231, 235, 0.10)" },
  { shape: [[0, 1, 1], [1, 1, 0]], color: "rgba(156, 163, 175, 0.11)" },
  { shape: [[1, 1, 0], [0, 1, 1]], color: "rgba(148, 163, 184, 0.10)" },
];

const route = useRoute();
const { data: session } = await useSession(useFetch);

useHead({
  meta: [
    { key: "viewport", name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" },
  ],
});

if (session.value?.user) {
  await navigateTo("/dashboard");
}

const loadingProvider = ref<SocialProvider | null>(null);
const tetrisCanvas = ref<HTMLCanvasElement | null>(null);

const authError = computed(() => {
  const error = Array.isArray(route.query.error) ? route.query.error[0] : route.query.error;

  if (!error) {
    return null;
  }

  const decodedError = decodeURIComponent(error);
  return AUTH_ERROR_MESSAGES[decodedError] ?? "Sign in failed. Please try again.";
});

async function continueWithProvider(provider: SocialProvider) {
  loadingProvider.value = provider;

  try {
    await signIn.social({
      provider,
      callbackURL: "/dashboard",
    });
  } finally {
    loadingProvider.value = null;
  }
}

function rotateShape(shape: number[][]) {
  return shape[0]!.map((_, columnIndex) => shape.map(row => row[columnIndex]!).reverse());
}

onMounted(() => {
  const canvas = tetrisCanvas.value;
  const context = canvas?.getContext("2d");

  if (!canvas || !context) return;

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

  function getViewportSize() {
    const visualViewport = window.visualViewport;

    return {
      width: visualViewport?.width ?? window.innerWidth,
      height: visualViewport?.height ?? window.innerHeight,
    };
  }

  function createBoard() {
    board = Array.from({ length: rows }, () => Array<TetrisCell>(columns).fill(null));
  }

  function seedBottomStack() {
    const stackHeight = Math.min(rows - 6, Math.max(5, Math.floor(rows * 0.22)));
    const colors = tetrisPieces.map(piece => piece.color);
    const wavePhase = Math.random() * Math.PI * 2;
    const columnHeights = Array.from({ length: columns }, (_, x) => {
      const progress = x / Math.max(1, columns - 1);
      const wave = Math.sin(progress * Math.PI * 2.4 + wavePhase) * 0.5 + Math.sin(progress * Math.PI * 5.2 + wavePhase * 0.6) * 0.22;
      const edgeFalloff = Math.sin(progress * Math.PI) * 0.9 + 0.1;
      const targetHeight = stackHeight * (0.38 + edgeFalloff * 0.28 + wave * 0.22);

      return Math.max(1, Math.min(stackHeight, Math.round(targetHeight)));
    });

    for (let rowOffset = 0; rowOffset < stackHeight; rowOffset += 1) {
      const y = rows - 1 - rowOffset;

      for (let x = 0; x < columns; x += 1) {
        const waveGap = Math.floor((Math.sin(rowOffset * 0.9 + wavePhase) * 0.5 + 0.5) * (columns - 5)) + 2;
        const isWaveGap = Math.abs(x - waveGap) <= (rowOffset % 5 === 0 ? 1 : 0);
        const isSmallGap = rowOffset > 1 && rowOffset < stackHeight - 1 && (x * 3 + rowOffset) % 17 === 0 && Math.random() > 0.7;

        if (!isWaveGap && !isSmallGap && rowOffset < columnHeights[x]!) {
          board[y]![x] = colors[(x + Math.floor(rowOffset / 2)) % colors.length]!;
        }
      }

      if (board[y]!.every(Boolean)) {
        board[y]![Math.floor((columns - 1) / 2)] = null;
      }
    }
  }

  function canPlace(piece: TetrisPiece, nextX = piece.x, nextY = piece.y, shape = piece.shape) {
    return canPlaceShape(shape, nextX, nextY);
  }

  function canPlaceShape(shape: number[][], nextX: number, nextY: number) {
    return shape.every((shapeRow, shapeY) => shapeRow.every((cell, shapeX) => {
      if (!cell) return true;

      const boardX = nextX + shapeX;
      const boardY = nextY + shapeY;

      return boardX >= 0 && boardX < columns && boardY < rows && (boardY < 0 || !board[boardY]![boardX]);
    }));
  }

  function shapesEqual(first: number[][], second: number[][]) {
    return first.length === second.length && first.every((row, rowIndex) => row.join("") === second[rowIndex]?.join(""));
  }

  function getShapeRotations(shape: number[][]) {
    const rotations: number[][][] = [];
    let nextShape = shape;

    for (let index = 0; index < 4; index += 1) {
      if (!rotations.some(rotation => shapesEqual(rotation, nextShape))) {
        rotations.push(nextShape);
      }
      nextShape = rotateShape(nextShape);
    }

    return rotations;
  }

  function scoreLanding(shape: number[][], x: number, y: number) {
    const testBoard = board.map(row => [...row]);

    shape.forEach((shapeRow, shapeY) => {
      shapeRow.forEach((cell, shapeX) => {
        const boardX = x + shapeX;
        const boardY = y + shapeY;

        if (cell && boardY >= 0 && boardY < rows && boardX >= 0 && boardX < columns) {
          testBoard[boardY]![boardX] = "preview";
        }
      });
    });

    const completedLines = testBoard.filter(row => row.every(Boolean)).length;
    const heights = Array.from({ length: columns }, (_, column) => {
      const firstBlock = testBoard.findIndex(row => Boolean(row[column]));
      return firstBlock === -1 ? 0 : rows - firstBlock;
    });
    const aggregateHeight = heights.reduce((total, height) => total + height, 0);
    const bumpiness = heights.slice(1).reduce((total, height, index) => total + Math.abs(height - heights[index]!), 0);
    let holes = 0;

    for (let column = 0; column < columns; column += 1) {
      let hasBlock = false;
      for (let row = 0; row < rows; row += 1) {
        if (testBoard[row]![column]) {
          hasBlock = true;
        } else if (hasBlock) {
          holes += 1;
        }
      }
    }

    return completedLines * 90 - aggregateHeight * 2.2 - holes * 12 - bumpiness * 3 + Math.random() * 4;
  }

  function chooseBestMove(shape: number[][]) {
    let bestMove: { shape: number[][]; x: number; score: number } | null = null;

    getShapeRotations(shape).forEach((rotation) => {
      const maxX = columns - rotation[0]!.length;
      for (let x = 0; x <= maxX; x += 1) {
        let y = -rotation.length;

        while (canPlaceShape(rotation, x, y + 1)) {
          y += 1;
        }

        if (!canPlaceShape(rotation, x, y)) continue;

        const score = scoreLanding(rotation, x, y);
        if (!bestMove || score > bestMove.score) {
          bestMove = { shape: rotation, x, score };
        }
      }
    });

    return bestMove ?? { shape, x: Math.max(0, Math.floor((columns - shape[0]!.length) / 2)), score: 0 };
  }

  function planPiece(piece: TetrisPiece) {
    const move = chooseBestMove(piece.shape);
    piece.targetShape = move.shape;
    piece.targetX = move.x;
  }

  function isReadyToDrop(piece: TetrisPiece) {
    return piece.x === piece.targetX && shapesEqual(piece.shape, piece.targetShape);
  }

  function hardDrop(piece: TetrisPiece) {
    while (canPlace(piece, piece.x, piece.y + 1)) {
      piece.y += 1;
    }
    piece.drawX = piece.x;
    piece.drawY = piece.y;
  }

  function spawnPiece() {
    const source = tetrisPieces[Math.floor(Math.random() * tetrisPieces.length)]!;
    const shape = source.shape;
    const pieceWidth = shape[0]!.length;
    const targetMove = chooseBestMove(shape);
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
          board[boardY]![boardX] = piece.color;
        }
      });
    });

    board = board.filter(row => row.some(cell => !cell));
    while (board.length < rows) {
      board.unshift(Array<TetrisCell>(columns).fill(null));
    }

    if (board.slice(0, 4).some(row => row.some(Boolean))) {
      createBoard();
    }
  }

  function updateCanvasSize() {
    const { width, height } = getViewportSize();
    const ratio = window.devicePixelRatio || 1;

    cellSize = width < 640 ? 14 : 18;
    columns = Math.max(12, Math.ceil(width / cellSize));
    rows = Math.max(18, Math.ceil(height / cellSize));
    canvas!.width = Math.ceil(width * ratio);
    canvas!.height = Math.ceil(height * ratio);
    canvas!.style.width = `${width}px`;
    canvas!.style.height = `${height}px`;
    context!.setTransform(ratio, 0, 0, ratio, 0, 0);
    createBoard();
    seedBottomStack();
    activePieces = [];
    for (let index = 0; index < maxVisibleTetrisPieces; index += 1) {
      spawnPiece();
    }
  }

  function drawBlock(x: number, y: number, color: string) {
    const inset = 1.5;
    const size = cellSize - inset * 2;

    context!.fillStyle = color;
    context!.strokeStyle = "rgba(255, 255, 255, 0.035)";
    context!.lineWidth = 1;
    context!.fillRect(x * cellSize + inset, y * cellSize + inset, size, size);
    context!.strokeRect(x * cellSize + inset, y * cellSize + inset, size, size);
  }

  function draw() {
    context!.clearRect(0, 0, canvas!.width, canvas!.height);

    context!.strokeStyle = "rgba(255, 255, 255, 0.018)";
    context!.lineWidth = 1;
    for (let x = 0; x <= columns; x += 1) {
      context!.beginPath();
      context!.moveTo(x * cellSize, 0);
      context!.lineTo(x * cellSize, rows * cellSize);
      context!.stroke();
    }
    for (let y = 0; y <= rows; y += 1) {
      context!.beginPath();
      context!.moveTo(0, y * cellSize);
      context!.lineTo(columns * cellSize, y * cellSize);
      context!.stroke();
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

      if (spawnTimer > 210 && activePieces.length < maxVisibleTetrisPieces) {
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
          const piece = activePieces[index]!;

          if (isReadyToDrop(piece)) {
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

        if (didLockPiece) {
          activePieces.forEach(planPiece);
        }
      }
    }

    draw();
    animationFrame = window.requestAnimationFrame(tick);
  }

  updateCanvasSize();
  draw();

  if (!reducedMotion) {
    animationFrame = window.requestAnimationFrame(tick);
  }

  window.addEventListener("resize", updateCanvasSize);
  window.visualViewport?.addEventListener("resize", updateCanvasSize);

  onUnmounted(() => {
    window.cancelAnimationFrame(animationFrame);
    window.removeEventListener("resize", updateCanvasSize);
    window.visualViewport?.removeEventListener("resize", updateCanvasSize);
  });
});

</script>

<template>
  <div class="relative flex h-dvh overflow-hidden bg-background">
    <canvas
      ref="tetrisCanvas"
      aria-hidden="true"
      class="pointer-events-none fixed inset-0 z-0 opacity-100"
    />
    <div
      class="pointer-events-none fixed inset-0 z-0"
      style="background: radial-gradient(circle at center, transparent 0%, oklch(0.145 0 0 / 0.18) 48%, var(--background) 100%)"
    />

    <div class="relative z-10 mx-auto flex h-full w-full max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 class="text-3xl font-bold tracking-tighter sm:text-4xl">
        Opendum
      </h1>
      <p class="mt-4 font-mono text-sm text-muted-foreground">
        Your accounts, one proxy.
      </p>

      <div
        v-if="authError"
        role="alert"
        class="relative mt-6 grid w-full grid-cols-[calc(var(--spacing)*4)_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg border bg-card px-4 py-3 text-left text-sm text-destructive"
      >
        <UiIcon name="i-lucide-circle-alert" class="size-4 translate-y-0.5 text-current" />
        <div class="col-start-2 grid justify-items-start gap-1 text-sm text-destructive/90">
          {{ authError }}
        </div>
      </div>

      <div class="mt-8 flex flex-col items-center gap-3">
        <div class="flex items-center justify-center gap-3">
          <button
            type="button"
            aria-label="Continue with GitHub"
            :disabled="loadingProvider !== null"
            class="relative inline-flex size-10 shrink-0 cursor-pointer items-center justify-center gap-2 overflow-visible whitespace-nowrap rounded-full border border-border/70 bg-background/80 text-sm font-medium text-foreground shadow-none outline-none transition-all hover:bg-muted/60 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"
            @click="continueWithProvider('github')"
          >
            <span v-if="loadingProvider === 'github'" class="absolute inset-0 rounded-full border border-primary/70 animate-ping" aria-hidden="true" />
            <svg :class="['h-5 w-5 transition-transform', loadingProvider === 'github' ? 'animate-pulse scale-110' : '']" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
          </button>

          <button
            type="button"
            aria-label="Continue with Google"
            :disabled="loadingProvider !== null"
            class="relative inline-flex size-10 shrink-0 cursor-pointer items-center justify-center gap-2 overflow-visible whitespace-nowrap rounded-full border border-border/70 bg-background/80 text-sm font-medium text-foreground shadow-none outline-none transition-all hover:bg-muted/60 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"
            @click="continueWithProvider('google')"
          >
            <span v-if="loadingProvider === 'google'" class="absolute inset-0 rounded-full border border-primary/70 animate-ping" aria-hidden="true" />
            <svg :class="['h-5 w-5 transition-transform', loadingProvider === 'google' ? 'animate-pulse scale-110' : '']" viewBox="0 0 48 48" aria-hidden="true">
              <path
                fill="#FFC107"
                d="M43.611 20.083H42V20H24v8h11.303C33.652 32.657 29.193 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.27 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
              />
              <path
                fill="#FF3D00"
                d="M6.306 14.691l6.571 4.819C14.655 16.108 19.001 13 24 13c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.27 4 24 4c-7.682 0-14.318 4.337-17.694 10.691z"
              />
              <path
                fill="#4CAF50"
                d="M24 44c5.067 0 9.77-1.939 13.332-5.101l-6.157-5.209C29.116 35.091 26.659 36 24 36c-5.173 0-9.625-3.316-11.302-7.946l-6.522 5.025C9.523 39.556 16.227 44 24 44z"
              />
              <path
                fill="#1976D2"
                d="M43.611 20.083H42V20H24v8h11.303c-.787 2.239-2.231 4.166-4.128 5.538l.003-.002 6.157 5.209C36.9 39.09 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
