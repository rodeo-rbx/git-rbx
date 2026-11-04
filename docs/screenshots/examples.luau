-- The README screenshots' example models, built with Lune:
--   lune run examples.luau <town|campfire> <variant> <out.rbxm>
-- town: before | moved (the house turned and slid, the two trees replanted)
-- campfire: orange | blue (the flames recolored, bigger and faster)
local fs = require("@lune/fs")
local process = require("@lune/process")
local roblox = require("@lune/roblox")

local Instance = roblox.Instance
local CFrame = roblox.CFrame
local Vector3 = roblox.Vector3
local Color3 = roblox.Color3
local Enum = roblox.Enum
local ColorSequence = roblox.ColorSequence
local ColorSequenceKeypoint = roblox.ColorSequenceKeypoint
local NumberSequence = roblox.NumberSequence
local NumberSequenceKeypoint = roblox.NumberSequenceKeypoint
local NumberRange = roblox.NumberRange

local which, variant, out = process.args[1], process.args[2], process.args[3]

local function part(parent, name, size, cframe, color, material, props)
	local p = Instance.new(props and props.class or "Part")
	p.Name = name
	p.Anchored = true
	p.Size = size
	p.CFrame = cframe
	p.Color = color
	p.Material = material
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	if props then
		for key, value in props do
			if key ~= "class" then
				p[key] = value
			end
		end
	end
	p.Parent = parent
	return p
end

local function model(parent, name, pivot)
	local m = Instance.new("Model")
	m.Name = name
	m.WorldPivotData = pivot
	m.Parent = parent
	return m
end

-- Every part of a model moved together, and its pivot with it: what Studio's
-- move and rotate tools do.
local function pivotTo(m, target)
	local delta = target * m.WorldPivotData:Inverse()
	for _, d in m:GetDescendants() do
		if d:IsA("BasePart") then
			d.CFrame = delta * d.CFrame
		end
	end
	m.WorldPivotData = target
end

local UPRIGHT = CFrame.Angles(0, 0, math.rad(90))

local function house(parent, at)
	local m = model(parent, "House", at)
	local function place(offset)
		return at * offset
	end
	local brick = Color3.fromRGB(196, 112, 82)
	local trim = Color3.fromRGB(240, 234, 220)
	part(
		m,
		"Floor",
		Vector3.new(16, 1, 16),
		place(CFrame.new(0, 0.5, 0)),
		Color3.fromRGB(150, 150, 150),
		Enum.Material.Concrete
	)
	part(m, "FrontWall", Vector3.new(16, 10, 1), place(CFrame.new(0, 6, 7.5)), brick, Enum.Material.Brick)
	part(m, "BackWall", Vector3.new(16, 10, 1), place(CFrame.new(0, 6, -7.5)), brick, Enum.Material.Brick)
	part(m, "LeftWall", Vector3.new(1, 10, 14), place(CFrame.new(-7.5, 6, 0)), brick, Enum.Material.Brick)
	part(m, "RightWall", Vector3.new(1, 10, 14), place(CFrame.new(7.5, 6, 0)), brick, Enum.Material.Brick)
	part(
		m,
		"Door",
		Vector3.new(3.5, 7, 0.3),
		place(CFrame.new(0, 4.5, 8.1)),
		Color3.fromRGB(92, 60, 40),
		Enum.Material.Wood
	)
	for i, x in { -4.75, 4.75 } do
		part(
			m,
			"Window" .. i,
			Vector3.new(3, 3, 0.3),
			place(CFrame.new(x, 6.5, 8.1)),
			Color3.fromRGB(150, 200, 230),
			Enum.Material.Glass,
			{ Transparency = 0.3 }
		)
	end
	part(
		m,
		"Window3",
		Vector3.new(0.3, 3, 3),
		place(CFrame.new(8.1, 6.5, 0)),
		Color3.fromRGB(150, 200, 230),
		Enum.Material.Glass,
		{ Transparency = 0.3 }
	)
	local slope = math.atan2(5, 9)
	local length = math.sqrt(9 * 9 + 5 * 5) + 0.6
	for _, side in { 1, -1 } do
		part(
			m,
			if side == 1 then "RoofFront" else "RoofBack",
			Vector3.new(18, 0.8, length),
			place(CFrame.new(0, 13.5, side * 4.5) * CFrame.Angles(side * slope, 0, 0)),
			Color3.fromRGB(70, 74, 86),
			Enum.Material.Slate
		)
	end
	-- Each gable end is two wedges, tall at the ridge. A wedge slopes down toward -Z.
	for _, x in { -7.5, 7.5 } do
		local side = if x < 0 then "Left" else "Right"
		part(
			m,
			"Gable" .. side .. "A",
			Vector3.new(1, 4.6, 7.5),
			place(CFrame.new(x, 13.3, -3.75)),
			trim,
			Enum.Material.WoodPlanks,
			{ class = "WedgePart" }
		)
		part(
			m,
			"Gable" .. side .. "B",
			Vector3.new(1, 4.6, 7.5),
			place(CFrame.new(x, 13.3, 3.75) * CFrame.Angles(0, math.pi, 0)),
			trim,
			Enum.Material.WoodPlanks,
			{ class = "WedgePart" }
		)
	end
	part(
		m,
		"Chimney",
		Vector3.new(2, 5, 2),
		place(CFrame.new(4.5, 15, -3.5)),
		Color3.fromRGB(120, 70, 60),
		Enum.Material.Brick
	)
	return m
end

local function tree(parent, name, at)
	local m = model(parent, name, at)
	part(
		m,
		"Trunk",
		Vector3.new(8, 1.6, 1.6),
		at * CFrame.new(0, 4, 0) * UPRIGHT,
		Color3.fromRGB(105, 72, 48),
		Enum.Material.Wood,
		{ Shape = Enum.PartType.Cylinder }
	)
	local green = Color3.fromRGB(74, 140, 66)
	for i, leaf in { { 0, 9, 0, 7 }, { 1.5, 11.5, 0.5, 5.5 }, { -1, 12.5, -1, 4.5 } } do
		part(
			m,
			"Leaves" .. i,
			Vector3.new(leaf[4], leaf[4], leaf[4]),
			at * CFrame.new(leaf[1], leaf[2], leaf[3]),
			green,
			Enum.Material.Grass,
			{ Shape = Enum.PartType.Ball }
		)
	end
	return m
end

local function lamp(parent, at)
	local m = model(parent, "Lamppost", at)
	local metal = Color3.fromRGB(40, 42, 48)
	part(m, "Pole", Vector3.new(0.6, 11, 0.6), at * CFrame.new(0, 5.5, 0), metal, Enum.Material.Metal)
	part(m, "Arm", Vector3.new(2.5, 0.4, 0.4), at * CFrame.new(1, 10.8, 0), metal, Enum.Material.Metal)
	local bulb = part(
		m,
		"Lamp",
		Vector3.new(1.2, 1.2, 1.2),
		at * CFrame.new(2, 10, 0),
		Color3.fromRGB(255, 220, 150),
		Enum.Material.Neon
	)
	local light = Instance.new("PointLight")
	light.Color = Color3.fromRGB(255, 210, 140)
	light.Range = 16
	light.Parent = bulb
	return m
end

local function fence(parent, at)
	local m = model(parent, "Fence", at)
	local white = Color3.fromRGB(235, 232, 225)
	for i = 0, 8 do
		part(
			m,
			"Post" .. i + 1,
			Vector3.new(0.6, 3.5, 0.6),
			at * CFrame.new(-12 + i * 3, 1.75, 0),
			white,
			Enum.Material.WoodPlanks
		)
	end
	for i, y in { 1.2, 2.6 } do
		part(m, "Rail" .. i, Vector3.new(24.6, 0.4, 0.3), at * CFrame.new(0, y, 0), white, Enum.Material.WoodPlanks)
	end
	return m
end

local function town(moved)
	local root = model(nil, "Town", CFrame.new())
	part(
		root,
		"Ground",
		Vector3.new(64, 1, 48),
		CFrame.new(0, -0.5, 0),
		Color3.fromRGB(96, 152, 78),
		Enum.Material.Grass
	)
	-- The front is -Z, where the camera looks from, so the house turns its door that way.
	local h = house(root, CFrame.new(0, 0, 2) * CFrame.Angles(0, math.pi, 0))
	local oak = tree(root, "Oak", CFrame.new(-18, 0, 6))
	local birch = tree(root, "Birch", CFrame.new(18, 0, 10))
	lamp(root, CFrame.new(11, 0, -12))
	fence(root, CFrame.new(-6, 0, -18))
	if moved then
		pivotTo(h, CFrame.new(-4, 0, -1) * CFrame.Angles(0, math.rad(180 + 30), 0))
		pivotTo(oak, CFrame.new(-21, 0, -9))
		pivotTo(birch, CFrame.new(20, 0, 0) * CFrame.Angles(0, math.rad(90), 0))
	end
	return root
end

local function campfire(blue)
	local root = model(nil, "Campfire", CFrame.new())
	part(
		root,
		"Ground",
		Vector3.new(16, 1, 16),
		CFrame.new(0, -0.5, 0),
		Color3.fromRGB(110, 92, 70),
		Enum.Material.Ground
	)
	for i = 0, 9 do
		local angle = i / 10 * math.pi * 2
		part(
			root,
			"Stone" .. i + 1,
			Vector3.new(1.4, 1, 1.2),
			CFrame.new(math.cos(angle) * 3.4, 0.4, math.sin(angle) * 3.4) * CFrame.Angles(0, -angle, 0),
			Color3.fromRGB(128, 126, 122),
			Enum.Material.Slate
		)
	end
	for i = 0, 3 do
		part(
			root,
			"Log" .. i + 1,
			Vector3.new(5, 0.8, 0.8),
			CFrame.new(0, 0.5 + i * 0.3, 0) * CFrame.Angles(0, i * math.pi / 4, 0),
			Color3.fromRGB(96, 64, 40),
			Enum.Material.Wood,
			{ Shape = Enum.PartType.Cylinder }
		)
	end
	local fire = part(
		root,
		"Fire",
		Vector3.new(2, 1, 2),
		CFrame.new(0, 1.2, 0),
		Color3.new(1, 1, 1),
		Enum.Material.SmoothPlastic,
		{ Transparency = 1, CanCollide = false }
	)

	local flames = Instance.new("ParticleEmitter")
	flames.Name = "Flames"
	flames.Texture = "rbxasset://textures/particles/fire_main.dds"
	flames.LightEmission = 1
	flames.Lifetime = NumberRange.new(0.7, 1.1)
	flames.SpreadAngle = roblox.Vector2.new(12, 12)
	flames.Acceleration = Vector3.new(0, 3, 0)
	flames.Drag = 1
	if blue then
		flames.Color = ColorSequence.new({
			ColorSequenceKeypoint.new(0, Color3.fromRGB(170, 240, 255)),
			ColorSequenceKeypoint.new(0.5, Color3.fromRGB(60, 140, 255)),
			ColorSequenceKeypoint.new(1, Color3.fromRGB(120, 40, 220)),
		})
		flames.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 3.2), NumberSequenceKeypoint.new(1, 0.4) })
		flames.Rate = 70
		flames.Speed = NumberRange.new(6, 9)
	else
		flames.Color = ColorSequence.new({
			ColorSequenceKeypoint.new(0, Color3.fromRGB(255, 220, 120)),
			ColorSequenceKeypoint.new(0.5, Color3.fromRGB(255, 120, 30)),
			ColorSequenceKeypoint.new(1, Color3.fromRGB(180, 30, 10)),
		})
		flames.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 2.2), NumberSequenceKeypoint.new(1, 0.2) })
		flames.Rate = 40
		flames.Speed = NumberRange.new(4, 6)
	end
	flames.Parent = fire

	local embers = Instance.new("ParticleEmitter")
	embers.Name = "Embers"
	embers.Texture = "rbxasset://textures/particles/sparkles_main.dds"
	embers.LightEmission = 1
	embers.Color = ColorSequence.new(if blue then Color3.fromRGB(150, 220, 255) else Color3.fromRGB(255, 190, 80))
	embers.Size = NumberSequence.new(0.25)
	embers.Lifetime = NumberRange.new(1, 2)
	embers.Rate = 20
	embers.Speed = NumberRange.new(5, 8)
	embers.SpreadAngle = roblox.Vector2.new(25, 25)
	embers.Parent = fire

	local light = Instance.new("PointLight")
	light.Color = if blue then Color3.fromRGB(110, 170, 255) else Color3.fromRGB(255, 150, 60)
	light.Range = 14
	light.Brightness = 2
	light.Parent = fire
	return root
end

local root
if which == "town" then
	root = town(variant == "moved")
elseif which == "campfire" then
	root = campfire(variant == "blue")
else
	error("which: town | campfire")
end
fs.writeFile(out, roblox.serializeModel({ root }))
print(`{out}: {#root:GetDescendants()} descendants`)
