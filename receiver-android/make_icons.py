"""Draws the launcher icon and the Android TV banner."""
from PIL import Image, ImageDraw, ImageFont

BG, FG = (18, 70, 120), (255, 255, 255)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def screen(d, x, y, w):
    h = int(w * 0.62)
    d.rounded_rectangle((x, y, x + w, y + h), radius=w // 12, outline=FG, width=max(4, w // 16))
    for i, r in enumerate((0.18, 0.34, 0.50)):
        rr = int(w * r)
        cx, cy = x + w // 6, y + h
        d.arc((cx - rr, cy - rr, cx + rr, cy + rr), 270, 360, fill=FG, width=max(4, w // 18))

icon = Image.new("RGB", (192, 192), BG)
screen(ImageDraw.Draw(icon), 30, 50, 132)
icon.save("res/drawable/icon.png")

banner = Image.new("RGB", (320, 180), BG)
d = ImageDraw.Draw(banner)
screen(d, 20, 55, 100)
d.text((135, 58), "Projector", fill=FG, font=ImageFont.truetype(FONT, 30))
d.text((135, 94), "Cast", fill=(150, 205, 255), font=ImageFont.truetype(FONT, 30))
banner.save("res/drawable/banner.png")
