"""MOVE OpenLab — a reproducible experimentation framework for optimization research.

The framework is problem-agnostic: an optimization problem (a *benchmark*) is described by a
:class:`move_openlab.problem.Problem` and registered through the ``move_openlab.problems`` entry-point group.
Methods are pure functions executed in isolated worker processes and judged by the problem's independent validator.
Campaigns are content-addressed, lockable, exportable as verified bundles, re-executable, extensible and comparable.
"""

__version__ = "0.2.0"
