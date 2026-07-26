// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray/TrayIcons.cs
//
// Generates simple solid-color-dot icons at runtime (System.Drawing)
// rather than shipping checked-in .ico binary assets — keeps this lane's
// deliverable fully text/source, with no binary art asset for review. A
// real icon set is a drop-in replacement later: swap Build()'s body for an
// embedded-resource .ico load; nothing in TrayApplicationContext.cs
// changes (it only calls TrayIcons.For(state)).

using System.Drawing;
using System.Drawing.Drawing2D;

namespace Loombre.Tray;

public enum TrayIconState
{
    Unknown,
    Running,
    Transitioning,
    Stopped,
    Crashed,
    Unreachable,
}

internal static class TrayIcons
{
    private static readonly Dictionary<TrayIconState, Icon> Cache = [];

    public static Icon For(TrayIconState state)
    {
        if (Cache.TryGetValue(state, out var cached))
        {
            return cached;
        }
        var icon = Build(ColorFor(state));
        Cache[state] = icon;
        return icon;
    }

    private static Color ColorFor(TrayIconState state) => state switch
    {
        TrayIconState.Running => Color.FromArgb(255, 46, 160, 67),        // green
        TrayIconState.Transitioning => Color.FromArgb(255, 210, 153, 34), // amber
        TrayIconState.Stopped => Color.FromArgb(255, 128, 128, 128),      // gray
        // P2.7's ember-red accent family (#E2453A) — reused here for the
        // two "something is wrong" states so the tray's failure color
        // matches the web client's own accent, not an arbitrary red.
        TrayIconState.Crashed => Color.FromArgb(255, 226, 69, 58),
        TrayIconState.Unreachable => Color.FromArgb(255, 226, 69, 58),
        _ => Color.FromArgb(255, 90, 90, 90),
    };

    private static Icon Build(Color color)
    {
        const int size = 32;
        using var bitmap = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var brush = new SolidBrush(color);
            g.FillEllipse(brush, 3, 3, size - 6, size - 6);
        }

        // Icon.FromHandle wraps (does not OWN) the HICON — a hardened build
        // should DestroyIcon(handle) once no longer needed. These icons are
        // cached one-per-state for the app's whole lifetime (at most 6
        // handles total, see the Cache dictionary above), so the leak is
        // bounded and reclaimed at process exit — flagged here rather than
        // silently accepted as correct.
        var handle = bitmap.GetHicon();
        return Icon.FromHandle(handle);
    }
}
