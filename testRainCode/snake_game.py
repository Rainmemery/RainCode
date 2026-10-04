import pygame
import sys
import random

# ================= 配置区域 =================
CELL_SIZE = 20          # 格子大小（像素）
GRID_WIDTH = 40         # 横向格子数
GRID_HEIGHT = 30        # 纵向格子数
FPS = 10                # 初始速度（帧率）
SPEED_INCREMENT = 0.2   # 每吃一个食物增加的速度

# 颜色定义 (R, G, B)
COLOR_BG = (30, 30, 30)
COLOR_SNAKE_HEAD = (0, 210, 0)
COLOR_SNAKE_BODY = (0, 170, 0)
COLOR_FOOD = (220, 50, 50)
COLOR_TEXT = (255, 255, 255)

SCREEN_WIDTH = CELL_SIZE * GRID_WIDTH
SCREEN_HEIGHT = CELL_SIZE * GRID_HEIGHT


class SnakeGame:
    def __init__(self):
        pygame.init()
        self.screen = pygame.display.set_mode((SCREEN_WIDTH, SCREEN_HEIGHT))
        pygame.display.set_caption("Python 贪吃蛇")
        self.clock = pygame.time.Clock()
        self.font = pygame.font.SysFont("microsoftyahei", 28)
        self.big_font = pygame.font.SysFont("microsoftyahei", 48)
        self.reset()

    def reset(self):
        """重置游戏状态"""
        center_x = (GRID_WIDTH // 2) * CELL_SIZE
        center_y = (GRID_HEIGHT // 2) * CELL_SIZE
        # 初始蛇身（向右移动）
        self.snake = [
            (center_x, center_y),
            (center_x - CELL_SIZE, center_y),
            (center_x - 2 * CELL_SIZE, center_y)
        ]
        self.direction = (CELL_SIZE, 0)  # (dx, dy)
        self.food = self._generate_food()
        self.score = 0
        self.current_fps = FPS
        self.game_over = False

    def _generate_food(self):
        """在空地上随机生成食物"""
        while True:
            x = random.randint(0, GRID_WIDTH - 1) * CELL_SIZE
            y = random.randint(0, GRID_HEIGHT - 1) * CELL_SIZE
            if (x, y) not in self.snake:
                return (x, y)

    def handle_events(self):
        """处理键盘与窗口事件"""
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()

            if event.type == pygame.KEYDOWN:
                if self.game_over and event.key == pygame.K_SPACE:
                    self.reset()
                    return

                if self.game_over:
                    return

                dx, dy = self.direction
                # 防止反向移动（如正在向右时不能直接向左）
                if event.key == pygame.K_UP and dy != CELL_SIZE:
                    self.direction = (0, -CELL_SIZE)
                elif event.key == pygame.K_DOWN and dy != -CELL_SIZE:
                    self.direction = (0, CELL_SIZE)
                elif event.key == pygame.K_LEFT and dx != CELL_SIZE:
                    self.direction = (-CELL_SIZE, 0)
                elif event.key == pygame.K_RIGHT and dx != -CELL_SIZE:
                    self.direction = (CELL_SIZE, 0)

    def update(self):
        """更新游戏逻辑"""
        if self.game_over:
            return

        head_x, head_y = self.snake[0]
        new_head = (head_x + self.direction[0], head_y + self.direction[1])

        # 撞墙检测
        if not (0 <= new_head[0] < SCREEN_WIDTH and 0 <= new_head[1] < SCREEN_HEIGHT):
            self._end_game()
            return

        # 撞自己检测
        if new_head in self.snake[:-1]:
            self._end_game()
            return

        self.snake.insert(0, new_head)

        # 吃食物检测
        if new_head == self.food:
            self.score += 1
            self.food = self._generate_food()
            # 轻微加速
            self.current_fps = min(FPS + self.score * SPEED_INCREMENT, 25)
        else:
            self.snake.pop()  # 没吃到则移除尾部，保持长度

    def _end_game(self):
        self.game_over = True

    def draw(self):
        """绘制画面"""
        self.screen.fill(COLOR_BG)

        # 绘制网格背景（可选，提升视觉效果）
        for x in range(0, SCREEN_WIDTH, CELL_SIZE):
            for y in range(0, SCREEN_HEIGHT, CELL_SIZE):
                pygame.draw.rect(self.screen, (35, 35, 35), (x, y, CELL_SIZE, CELL_SIZE), 1)

        # 绘制蛇
        for i, pos in enumerate(self.snake):
            color = COLOR_SNAKE_HEAD if i == 0 else COLOR_SNAKE_BODY
            rect = pygame.Rect(pos[0], pos[1], CELL_SIZE, CELL_SIZE)
            pygame.draw.rect(self.screen, color, rect)
            pygame.draw.rect(self.screen, COLOR_BG, rect, 1)  # 边框分割蛇节

        # 绘制食物（圆形）
        food_center = (self.food[0] + CELL_SIZE // 2, self.food[1] + CELL_SIZE // 2)
        pygame.draw.circle(self.screen, COLOR_FOOD, food_center, CELL_SIZE // 2 - 1)

        # 绘制分数
        score_surf = self.font.render(f"得分: {self.score}", True, COLOR_TEXT)
        self.screen.blit(score_surf, (10, 10))

        # 绘制提示
        hint = "方向键控制移动 | 空格暂停/继续"
        if not self.game_over:
            hint += " | 暂停请再按一次空格"
        hint_surf = self.font.render(hint, True, (180, 180, 180))
        self.screen.blit(hint_surf, (SCREEN_WIDTH // 2 - hint_surf.get_width() // 2, SCREEN_HEIGHT - 30))

        # 游戏结束遮罩
        if self.game_over:
            overlay = pygame.Surface((SCREEN_WIDTH, SCREEN_HEIGHT))
            overlay.set_alpha(160)
            overlay.fill((0, 0, 0))
            self.screen.blit(overlay, (0, 0))

            over_text = self.big_font.render("游戏结束", True, COLOR_TEXT)
            sub_text = self.font.render(f"最终得分: {self.score}  |  按空格键重新开始", True, (200, 200, 200))
            self.screen.blit(over_text, (SCREEN_WIDTH // 2 - over_text.get_width() // 2, SCREEN_HEIGHT // 2 - 40))
            self.screen.blit(sub_text, (SCREEN_WIDTH // 2 - sub_text.get_width() // 2, SCREEN_HEIGHT // 2 + 10))

        pygame.display.flip()

    def run(self):
        """主循环"""
        paused = False
        while True:
            self.handle_events()

            if not self.game_over and not paused:
                self.update()

            self.draw()

            if paused:
                pause_text = self.big_font.render("暂停中", True, COLOR_TEXT)
                self.screen.blit(pause_text, (SCREEN_WIDTH // 2 - pause_text.get_width() // 2, SCREEN_HEIGHT // 2))
                pygame.display.flip()

            self.clock.tick(self.current_fps if not paused else FPS)


if __name__ == "__main__":
    game = SnakeGame()
    game.run()
